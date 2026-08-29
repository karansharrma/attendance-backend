import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

export const API_PREFIX = 'api/v1';

/**
 * Everything that turns a bare Nest app into *this* API.
 *
 * Shared by main.ts and the e2e suite on purpose: global pipes applied only in main.ts are
 * the classic way for tests to pass against validation rules that do not actually run in
 * production, or vice versa.
 */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get(ConfigService);

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());

  const origins = config.get<string>('CORS_ORIGINS', '*');
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((value) => value.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown keys rather than trusting them, and reject outright when a client
      // sends fields the DTO does not declare -- almost always a version mismatch worth
      // surfacing rather than silently ignoring.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );

  // Prisma returns BigInt from raw COUNT(*) aggregates, which JSON.stringify cannot encode.
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
    return this.toString();
  };

  return app;
}
