import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * The single error shape every route produces.
 *
 * The Android Retrofit client parses exactly this, and its sync worker keys its
 * retryable-versus-permanent decision off `statusCode`, so drift here is not cosmetic:
 * an unshaped 500 leaking out as a 4xx would silently poison the offline queue.
 */
export interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path?: string;
  timestamp?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message, error } = this.normalise(exception);

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error,
      path: request?.url,
      timestamp: new Date().toISOString(),
    };

    // 5xx means we broke; 4xx means the caller did. Only the former deserves a stack trace.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request?.method} ${request?.url} -> ${statusCode}: ${JSON.stringify(message)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request?.method} ${request?.url} -> ${statusCode}: ${JSON.stringify(message)}`,
      );
    }

    response.status(statusCode).json(body);
  }

  private normalise(exception: unknown): {
    statusCode: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { statusCode: status, message: payload, error: exception.name };
      }

      const record = payload as Record<string, unknown>;
      return {
        statusCode: status,
        // ValidationPipe puts the per-field failures here as a string[]; keep them.
        message: (record.message as string | string[]) ?? exception.message,
        error: (record.error as string) ?? exception.name,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'The request did not match the expected data shape.',
        error: 'Bad Request',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
    };
  }

  /**
   * Prisma error codes mapped to the status the mobile client should act on. Anything not
   * listed stays a 500 so a genuine bug is never mistaken for a permanent client error.
   */
  private fromPrisma(exception: Prisma.PrismaClientKnownRequestError): {
    statusCode: number;
    message: string;
    error: string;
  } {
    switch (exception.code) {
      case 'P2002': {
        const target = (exception.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        return {
          statusCode: HttpStatus.CONFLICT,
          message: `A record with that ${target} already exists.`,
          error: 'Conflict',
        };
      }
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Referenced record does not exist.',
          error: 'Bad Request',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found.',
          error: 'Not Found',
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
          error: 'Internal Server Error',
        };
    }
  }
}
