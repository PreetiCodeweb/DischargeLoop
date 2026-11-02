import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './domain/domain-error.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DomainErrorFilter());
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id', 'Last-Event-ID'],
    exposedHeaders: ['X-Correlation-Id'],
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    next();
  });

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  process.stdout.write(JSON.stringify({ level: 'info', message: 'api_started', port, correlationId: randomUUID() }) + '\n');
}

void bootstrap();
