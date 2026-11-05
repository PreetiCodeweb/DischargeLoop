import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OidcGuard } from '../auth/oidc.guard';
import { Roles } from '../auth/roles.decorator';
import type { Actor, AuthenticatedRequest } from '../auth/auth.types';
import { DomainError } from '../domain/domain-error';
import { WorkflowService, type TaskInput } from './workflow.service';

const READ = ['admission', 'clinical', 'coordinator', 'pharmacy', 'billing', 'transport',
  'housekeeping', 'bed_manager', 'admin', 'auditor'];
const ADMISSION = ['admission', 'coordinator', 'admin'];
const CLINICAL = ['clinical', 'coordinator', 'admin'];
const TASK_ROLES = ['clinical', 'coordinator', 'pharmacy', 'billing', 'transport', 'housekeeping', 'admin'];
const HOUSEKEEPING = ['housekeeping', 'bed_manager', 'admin'];
const VERIFY = ['bed_manager', 'admin'];

@Controller('/api/v1')
@UseGuards(OidcGuard)
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  private actor(request: AuthenticatedRequest): Actor {
    if (!request.actor) throw new DomainError('UNAUTHENTICATED', 'Authentication required', 401);
    return request.actor;
  }

  private body(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DomainError('INVALID_REQUEST_BODY', 'A JSON object is required', 400);
    }
    return value as Record<string, unknown>;
  }

  private str(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new DomainError('INVALID_REQUEST', `${field} must be a non-empty string`, 400);
    }
    return value;
  }

  @Get('wards')
  @Roles(...READ)
  wards(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>[]> {
    return this.workflow.wards(this.actor(request));
  }

  @Get('encounters')
  @Roles(...READ)
  encounters(@Req() request: AuthenticatedRequest, @Query('ward') wardId?: string, @Query('status') status?: string) {
    return this.workflow.encounters(this.actor(request), { wardId, status });
  }

  @Post('patients')
  @Roles(...ADMISSION)
  createPatient(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = this.body(body);
    return this.workflow.createPatient(this.actor(request), {
      displayName: this.str(input.displayName, 'displayName'),
      dateOfBirth: typeof input.dateOfBirth === 'string' ? input.dateOfBirth : undefined,
      sex: typeof input.sex === 'string' ? input.sex : undefined,
    });
  }

  @Post('encounters')
  @Roles(...ADMISSION)
  createEncounter(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = this.body(body);
    return this.workflow.createEncounter(this.actor(request), {
      patientId: this.str(input.patientId, 'patientId'),
      wardId: this.str(input.wardId, 'wardId'),
    });
  }

  @Get('discharges')
  @Roles(...READ)
  discharges(@Req() request: AuthenticatedRequest, @Query('ward') wardId?: string, @Query('state') state?: string) {
    return this.workflow.discharges(this.actor(request), { wardId, state });
  }

  @Get('discharges/:id')
  @Roles(...READ)
  dischargeDetail(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflow.dischargeDetail(this.actor(request), id);
  }

  @Post('discharges/:id/tasks')
  @Roles(...CLINICAL)
  addTask(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = this.body(body);
    const task: TaskInput = {
      type: this.str(input.type, 'type'),
      title: this.str(input.title, 'title'),
      ownerRole: this.str(input.ownerRole, 'ownerRole'),
      priority: typeof input.priority === 'number' ? input.priority : undefined,
      blocking: typeof input.blocking === 'boolean' ? input.blocking : undefined,
      dueMinutes: typeof input.dueMinutes === 'number' ? input.dueMinutes : undefined,
    };
    return this.workflow.addTask(this.actor(request), id, task);
  }

  @Get('tasks')
  @Roles(...READ)
  tasks(@Req() request: AuthenticatedRequest, @Query('role') role?: string, @Query('status') status?: string) {
    return this.workflow.tasks(this.actor(request), { role, status });
  }

  @Patch('tasks/:id')
  @Roles(...TASK_ROLES)
  updateTask(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = this.body(body);
    return this.workflow.updateTask(this.actor(request), id, this.str(input.action, 'action'));
  }

  @Get('cleaning')
  @Roles(...READ)
  cleaning(@Req() request: AuthenticatedRequest, @Query('ward') wardId?: string) {
    return this.workflow.cleaning(this.actor(request), { wardId });
  }

  @Post('cleaning/:id/accept')
  @Roles(...HOUSEKEEPING)
  acceptCleaning(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflow.acceptCleaning(this.actor(request), id);
  }

  @Post('cleaning/:id/verify')
  @Roles(...VERIFY)
  verifyCleaning(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflow.verifyCleaning(this.actor(request), id);
  }

  @Get('audit')
  @Roles(...READ)
  audit(@Req() request: AuthenticatedRequest, @Query('limit') limit?: string) {
    return this.workflow.audit(this.actor(request), limit ? Number(limit) : 100);
  }

  @Get('analytics')
  @Roles(...READ)
  analytics(@Req() request: AuthenticatedRequest) {
    return this.workflow.analytics(this.actor(request));
  }
}
