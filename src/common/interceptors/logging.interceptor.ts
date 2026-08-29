import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * One structured line per request.
 *
 * Deliberately logs no request bodies: they carry passwords on /auth/login and face
 * embedding bytes on /enrollment, neither of which belongs in a log aggregator.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { sub?: string } }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(request, http.getResponse<Response>().statusCode, startedAt),
        // Errors are logged with their status by AllExceptionsFilter; just record the timing.
        error: () => this.write(request, 0, startedAt),
      }),
    );
  }

  private write(
    request: Request & { user?: { sub?: string } },
    statusCode: number,
    startedAt: number,
  ): void {
    const duration = Date.now() - startedAt;
    const actor = request.user?.sub ? ` actor=${request.user.sub}` : '';
    const status = statusCode > 0 ? ` ${statusCode}` : '';
    this.logger.log(`${request.method} ${request.url}${status} ${duration}ms${actor}`);
  }
}
