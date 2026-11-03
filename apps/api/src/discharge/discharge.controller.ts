import {
  Controller,
  Post,
  Patch,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { DischargeService } from './discharge.service';
import { OidcGuard } from '../auth/oidc.guard';
import { Roles } from '../auth/roles.decorator';
import { DomainError } from '../domain/domain-error';
import type { Actor, AuthenticatedRequest } from '../auth/auth.types';

const DISCHARGE_ROLES = ['clinical', 'coordinator', 'admin'];

@Controller('api/v1/discharges')
@UseGuards(OidcGuard)
export class DischargeController {
  constructor(private readonly dischargeService: DischargeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(...DISCHARGE_ROLES)
  async initiateDischarge(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = this.body(body);
    const actor = this.actor(request);
    return this.dischargeService.initiateDischarge(actor, {
      encounterId: this.string(input.encounterId, 'encounterId'),
      initiatedBy: this.string(input.initiatedBy, 'initiatedBy'),
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(...DISCHARGE_ROLES)
  async updateDischargeState(
    @Req() request: AuthenticatedRequest,
    @Param('id') dischargeId: string,
    @Body() body: unknown,
  ) {
    const input = this.body(body);
    const actor = this.actor(request);

    // Offline mode restriction: Safety-critical state changes require live connection
    const criticalStates = ['CANCELLED_REVERSED', 'DEPARTED', 'READY_TO_DEPART'];
    const offlineMode = request.headers['x-offline-mode'];
    if (criticalStates.includes(input.targetState as string) && offlineMode === 'true') {
      throw new DomainError('SAFETY_CRITICAL_OFFLINE_BLOCKED', 'Critical discharge state changes cannot be queued while offline', 409);
    }

    return this.dischargeService.updateDischargeState(actor, {
      dischargeId,
      targetState: this.string(input.targetState, 'targetState'),
      reasonCode: input.reasonCode as string | undefined,
      reversalReason: input.reversalReason as string | undefined,
      idempotencyKey: this.header(request, 'idempotency-key'),
      correlationId: this.header(request, 'x-correlation-id'),
    });
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
}
