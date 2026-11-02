import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError } from './domain-error';

@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    let status = 500;
    let title = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let dependencies: unknown;

    if (exception instanceof DomainError) {
      status = exception.statusCode;
      title = exception.message;
      code = exception.code;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const bodyRecord = typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined;
      const message = bodyRecord?.message;
      title = typeof message === 'string' ? message : status === 503 ? 'Current state is unknown' : 'Request failed';
      dependencies = bodyRecord?.dependencies;
      code = status === 503 ? 'STATE_UNKNOWN'
        : status === 401 ? 'UNAUTHENTICATED'
          : status === 403 ? 'FORBIDDEN'
            : status === 404 ? 'NOT_FOUND'
              : status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED';
    } else if (isDatabaseUnavailable(exception)) {
      status = 503;
      title = 'Current state is unknown';
      code = 'STATE_UNKNOWN';
    }

    const problem: Record<string, unknown> = { type: 'about:blank', title, status, code };
    if (dependencies !== undefined) problem.dependencies = dependencies;
    response
      .status(status)
      .type('application/problem+json')
      .send(problem);
  }
}

function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code.startsWith('08') || code.startsWith('53')
    || ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(code);
}
