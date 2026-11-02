import { HealthService } from './health.service';
import { describe, expect, it, vi } from 'vitest';

describe('HealthService', () => {
  it('reports not ready while required dependencies are not configured', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    const result = await new HealthService().readiness();
    expect(result).toEqual({
      status: 'not_ready',
      dependencies: { database: 'unavailable', queue: 'unavailable', ehr: 'not_configured' },
    });
  });

  it('does not report readiness before the EHR adapter is configured', async () => {
    const service = new HealthService();
    const probes = service as unknown as {
      checkDatabase: () => Promise<'ok'>;
      checkQueue: () => Promise<'ok'>;
    };
    vi.spyOn(probes, 'checkDatabase').mockResolvedValue('ok');
    vi.spyOn(probes, 'checkQueue').mockResolvedValue('ok');

    await expect(service.readiness()).resolves.toEqual({
      status: 'not_ready',
      dependencies: { database: 'ok', queue: 'ok', ehr: 'not_configured' },
    });
  });
});
