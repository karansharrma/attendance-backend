import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './common/bootstrap';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const logger = new Logger('Bootstrap');

  configureApp(app);

  app.enableShutdownHooks();
  app.get(PrismaService).enableShutdownHooks(app);

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`Attendance API listening on http://0.0.0.0:${port}/${API_PREFIX}`);
  logger.log(`Environment: ${config.get<string>('NODE_ENV', 'development')}`);
}

void bootstrap();
