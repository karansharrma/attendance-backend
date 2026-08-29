import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    // Surface Prisma's own warnings and errors through the Nest logger rather than stdout,
    // so they land in the same structured stream as everything else.
    (this as unknown as { $on: (event: string, cb: (e: { message: string }) => void) => void }).$on(
      'warn',
      (event) => this.logger.warn(event.message),
    );
    (this as unknown as { $on: (event: string, cb: (e: { message: string }) => void) => void }).$on(
      'error',
      (event) => this.logger.error(event.message),
    );

    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Used by the e2e suite to reset between runs. Refuses to run outside test. */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll is only available when NODE_ENV=test');
    }
    await this.attendanceRecord.deleteMany();
    await this.employeeSite.deleteMany();
    await this.site.deleteMany();
    await this.employee.deleteMany();
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
