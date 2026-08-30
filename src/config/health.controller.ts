import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
@SkipThrottle({ auth: true })
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Unauthenticated on purpose: container orchestrators cannot hold a JWT. */
  @Public()
  @Get()
  async check(): Promise<{ status: string; database: string; uptimeSeconds: number }> {
    let database = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
