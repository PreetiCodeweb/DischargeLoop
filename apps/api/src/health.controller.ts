import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<Record<string, unknown>> {
    const state = await this.health.readiness();
    if (state.status !== 'ready') {
      throw new ServiceUnavailableException(state);
    }
    return state;
  }
}
