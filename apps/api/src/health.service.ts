import { Injectable } from '@nestjs/common';
import { Client } from 'pg';
import { createClient } from 'redis';

type DependencyState = 'ok' | 'unavailable' | 'not_configured';

@Injectable()
export class HealthService {
  async readiness(): Promise<{
    status: 'ready' | 'not_ready';
    dependencies: { database: DependencyState; queue: DependencyState; ehr: DependencyState };
  }> {
    const [database, queue] = await Promise.all([this.checkDatabase(), this.checkQueue()]);
    // M0 has no EHR adapter yet. Never infer a live integration from a config flag.
    const ehr: DependencyState = 'not_configured';
    const dependencies = { database, queue, ehr };
    const ready = ([database, queue, ehr] as DependencyState[]).every((dependency) => dependency === 'ok');
    return { status: ready ? 'ready' : 'not_ready', dependencies };
  }

  private async checkDatabase(): Promise<DependencyState> {
    if (!process.env.DATABASE_URL) return 'unavailable';
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async checkQueue(): Promise<DependencyState> {
    if (!process.env.REDIS_URL) return 'unavailable';
    const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1500 } });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      if (client.isOpen) await client.quit().catch(() => undefined);
    }
  }
}
