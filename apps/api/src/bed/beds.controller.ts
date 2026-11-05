import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { OidcGuard } from '../auth/oidc.guard';
import { Roles } from '../auth/roles.decorator';
import type { Actor, AuthenticatedRequest } from '../auth/auth.types';
import { DomainError } from '../domain/domain-error';
import { BED_STATES, type BedState } from '../domain/bed-state';
import { BedInventoryService, type BedReasonCode } from './bed-inventory.service';

const READ_ROLES = [
  'admission', 'clinical', 'coordinator', 'pharmacy', 'billing', 'transport',
  'housekeeping', 'bed_manager', 'admin', 'auditor',
];
const ADMISSION_ROLES = ['admission', 'coordinator', 'admin'];
const BLOCK_ROLES = ['clinical', 'coordinator', 'housekeeping', 'bed_manager', 'admin'];

@Controller('/api/v1')
@UseGuards(OidcGuard)
export class BedsController {
  constructor(private readonly beds: BedInventoryService) {}

  @Get('beds')
  @Roles(...READ_ROLES)
  async bedboard(
    @Req() request: AuthenticatedRequest,
    @Query('ward') wardId?: string,
    @Query('state') state?: string,
  ): Promise<Record<string, unknown>[]> {
    if (state && !BED_STATES.includes(state as BedState)) {
      throw new DomainError('INVALID_BED_STATE', 'Unknown bed state filter', 400);
    }
    return this.beds.bedboard(this.actor(request), { wardId, state: state as BedState | undefined });
  }

  @Get('beds/:bedId')
  @Roles(...READ_ROLES)
  bedDetail(@Req() request: AuthenticatedRequest, @Param('bedId') bedId: string): Promise<Record<string, unknown>> {
    return this.beds.bedDetail(this.actor(request), bedId);
  }

  @Sse('events/stream')
  @Roles(...READ_ROLES)
  eventStream(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    const actor = this.actor(request);
    return new Observable<MessageEvent>((subscriber) => {
      let disposed = false;
      let initialized = false;
      let cursor: string | null = null;
      let lastHeartbeat = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const poll = async (): Promise<void> => {
        try {
          if (!initialized) {
            const snapshot = await this.beds.bedSnapshot(actor);
            cursor = snapshot.cursor;
            subscriber.next({
              id: cursor ?? undefined,
              type: 'snapshot',
              data: { beds: snapshot.beds, cursor },
            });
            initialized = true;
          } else {
            const batch = await this.beds.eventsAfter(actor, cursor);
            cursor = batch.cursor;
            for (const event of batch.events) {
              subscriber.next({
                id: event.id,
                type: event.type,
                data: { ...event.payload, occurredAt: event.occurredAt },
              });
            }
          }

          if (Date.now() - lastHeartbeat >= 20_000) {
            subscriber.next({ id: cursor ?? undefined, type: 'heartbeat', data: { at: new Date().toISOString() } });
            lastHeartbeat = Date.now();
          }
          if (!disposed) timer = setTimeout(() => void poll(), 1000);
        } catch (error) {
          subscriber.error(error);
        }
      };

      void poll();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      };
    });
  }

  @Post('reservations')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...ADMISSION_ROLES)
  async reserve(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const input = this.body(body);
    const result = await this.beds.reserve(this.actor(request), {
      bedId: this.string(input.bedId, 'bedId'),
      ttlSeconds: input.ttlSeconds === undefined ? undefined : this.integer(input.ttlSeconds, 'ttlSeconds'),
      reasonCode: this.reason(input.reasonCode, 'RESERVATION_REQUESTED'),
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    });
    return result.body;
  }

  @Delete('reservations/:reservationId')
  @Roles(...ADMISSION_ROLES)
  async cancelReservation(
    @Req() request: AuthenticatedRequest,
    @Param('reservationId') reservationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = this.body(body);
    const result = await this.beds.cancelReservation(this.actor(request), {
      reservationId,
      reasonCode: this.reason(input.reasonCode, 'RESERVATION_CANCELLED'),
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    });
    return result.body;
  }

  @Post('reservations/:reservationId/confirm')
  @Roles(...ADMISSION_ROLES)
  async confirmAdmission(
    @Req() request: AuthenticatedRequest,
    @Param('reservationId') reservationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = this.body(body);
    const result = await this.beds.confirmAdmission(this.actor(request), {
      reservationId,
      encounterId: this.string(input.encounterId, 'encounterId'),
      reasonCode: this.reason(input.reasonCode, 'ADMISSION_CONFIRMED'),
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    });
    return result.body;
  }

  @Post('beds/:bedId/block')
  @Roles(...BLOCK_ROLES)
  blockBed(@Req() request: AuthenticatedRequest, @Param('bedId') bedId: string): Promise<Record<string, unknown>> {
    return this.changeState(request, {
      bedId, target: 'BLOCKED', reasonCode: 'CLINICAL_BLOCK',
    });
  }

  @Post('beds/:bedId/unblock')
  @Roles(...BLOCK_ROLES)
  unblockBed(@Req() request: AuthenticatedRequest, @Param('bedId') bedId: string): Promise<Record<string, unknown>> {
    return this.changeState(request, {
      bedId, target: 'AVAILABLE', reasonCode: 'CLINICAL_UNBLOCK',
    });
  }

  @Post('beds/:bedId/maintenance')
  @Roles(...BLOCK_ROLES)
  startMaintenance(@Req() request: AuthenticatedRequest, @Param('bedId') bedId: string): Promise<Record<string, unknown>> {
    return this.changeState(request, {
      bedId, target: 'MAINTENANCE', reasonCode: 'MAINTENANCE_STARTED',
    });
  }

  @Post('beds/:bedId/maintenance/complete')
  @Roles(...BLOCK_ROLES)
  completeMaintenance(@Req() request: AuthenticatedRequest, @Param('bedId') bedId: string): Promise<Record<string, unknown>> {
    return this.changeState(request, {
      bedId, target: 'AVAILABLE', reasonCode: 'MAINTENANCE_COMPLETED',
    });
  }

  private changeState(
    request: AuthenticatedRequest,
    change: { bedId: string; target: 'BLOCKED' | 'MAINTENANCE' | 'AVAILABLE'; reasonCode: Extract<BedReasonCode, 'CLINICAL_BLOCK' | 'CLINICAL_UNBLOCK' | 'MAINTENANCE_STARTED' | 'MAINTENANCE_COMPLETED'> },
  ): Promise<Record<string, unknown>> {
    return this.beds.changeBedState(this.actor(request), {
      ...change,
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    }).then((result) => result.body);
  }

  private actor(request: AuthenticatedRequest): Actor {
    if (!request.actor) throw new DomainError('UNAUTHENTICATED', 'Authentication required', 401);
    return request.actor;
  }

  private header(request: AuthenticatedRequest, name: string): string {
    const value = request.headers[name];
    if (typeof value !== 'string') {
      if (name === 'idempotency-key') throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', 400);
      throw new DomainError('CORRELATION_ID_REQUIRED', 'X-Correlation-Id header is required', 400);
    }
    return value;
  }

  private body(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DomainError('INVALID_REQUEST_BODY', 'A JSON object is required', 400);
    }
    return value as Record<string, unknown>;
  }

  private string(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 160) {
      throw new DomainError('INVALID_REQUEST', `${field} must be a non-empty string`, 400);
    }
    return value;
  }

  private integer(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new DomainError('INVALID_REQUEST', `${field} must be an integer`, 400);
    }
    return value;
  }

  private reason<const T extends BedReasonCode>(value: unknown, expected: T): T {
    if (value === undefined) return expected;
    if (value !== expected) throw new DomainError('INVALID_REASON_CODE', `reasonCode must be ${expected}`, 400);
    return expected;
  }
}
