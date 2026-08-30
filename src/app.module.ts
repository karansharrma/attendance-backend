import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { validateEnvironment } from './common/config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { DeviceConfigModule } from './config/device-config.module';
import { EmployeesModule } from './employees/employees.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { PrismaModule } from './prisma/prisma.module';
import { SitesModule } from './sites/sites.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Refuse to boot on a missing DATABASE_URL or a weak JWT secret rather than starting
      // up in a broken or insecure state.
      validate: validateEnvironment,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'global',
          ttl: config.get<number>('THROTTLE_GLOBAL_TTL_SECONDS', 60) * 1000,
          limit: config.get<number>('THROTTLE_GLOBAL_LIMIT', 120),
        },
        {
          // Tighter bucket for /auth routes. Other controllers explicitly skip it: named
          // throttlers are evaluated globally by ThrottlerGuard unless skipped.
          name: 'auth',
          ttl: config.get<number>('THROTTLE_AUTH_TTL_SECONDS', 60) * 1000,
          limit: config.get<number>('THROTTLE_AUTH_LIMIT', 5),
        },
      ],
    }),

    PrismaModule,
    NotificationsModule,
    AuthModule,
    EmployeesModule,
    SitesModule,
    AttendanceModule,
    EnrollmentModule,
    AdminModule,
    DeviceConfigModule,
  ],
  providers: [
    // Order matters: throttling runs first (cheapest rejection), then authentication, then
    // authorisation. Authentication is global so a new route is protected by default and has
    // to opt out with @Public().
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
