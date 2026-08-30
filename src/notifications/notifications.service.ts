import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { PunchType, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SyncAttendanceRecordDto } from '../attendance/dto/sync-attendance.dto';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private messaging: Messaging | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const rawCredential = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!rawCredential) {
      this.logger.warn('Firebase is not configured; push notifications will be skipped');
      return;
    }

    try {
      const credential = JSON.parse(rawCredential) as Record<string, string>;
      const app: App = getApps()[0] ?? initializeApp({ credential: cert(credential) });
      this.messaging = getMessaging(app);
      this.logger.log('Firebase Cloud Messaging is configured');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid credential';
      this.logger.error(
        `Firebase configuration is invalid; push notifications disabled: ${message}`,
      );
    }
  }

  async registerToken(employeeId: string, dto: RegisterPushTokenDto) {
    const registered = await this.prisma.pushToken.upsert({
      where: { token: dto.token },
      create: { employeeId, token: dto.token, platform: dto.platform },
      update: { employeeId, platform: dto.platform },
    });
    return { id: registered.id, platform: registered.platform, registered: true };
  }

  async unregisterToken(employeeId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { employeeId, token } });
  }

  async getPreferences(adminId: string) {
    const admin = await this.prisma.employee.findUniqueOrThrow({
      where: { id: adminId },
      select: { punchOutNotificationsEnabled: true },
    });
    return admin;
  }

  async updatePreferences(adminId: string, dto: UpdateNotificationPreferencesDto) {
    return this.prisma.employee.update({
      where: { id: adminId },
      data: dto,
      select: { punchOutNotificationsEnabled: true },
    });
  }

  async notifyEmployeeOfSiteAssignment(employeeId: string, siteId: string): Promise<void> {
    const [employee, site] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true } }),
      this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, name: true } }),
    ]);
    if (!employee || !site) return;

    await this.sendToEmployee(employeeId, {
      title: 'New site assigned',
      body: `${site.name} has been assigned to you.`,
      data: { event: 'site_assigned', siteId: site.id, siteName: site.name },
    });
  }

  async notifyAdminsOfAttendance(
    employeeId: string,
    record: SyncAttendanceRecordDto,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { name: true },
    });
    if (!employee) return;

    const isPunchOut = record.punchType === PunchType.OUT;
    const admins = await this.prisma.employee.findMany({
      where: {
        role: Role.ADMIN,
        ...(isPunchOut ? { punchOutNotificationsEnabled: true } : {}),
      },
      select: { id: true },
    });
    const action = isPunchOut ? 'punched out' : 'punched in';
    await Promise.all(
      admins.map((admin) =>
        this.sendToEmployee(admin.id, {
          title: `Employee ${action}`,
          body: `${employee.name} ${action}.`,
          data: {
            event: isPunchOut ? 'attendance_punch_out' : 'attendance_punch_in',
            attendanceId: record.id,
            employeeId,
            punchType: record.punchType,
            timestamp: record.timestamp,
          },
        }),
      ),
    );
  }

  private async sendToEmployee(
    employeeId: string,
    message: { title: string; body: string; data: Record<string, string> },
  ): Promise<void> {
    const tokens = await this.prisma.pushToken.findMany({
      where: { employeeId },
      select: { token: true },
    });
    if (tokens.length === 0) return;
    if (!this.messaging) {
      this.logger.debug(`Would notify ${employeeId}: ${message.data.event}`);
      return;
    }

    try {
      const response = await this.messaging.sendEachForMulticast({
        tokens: tokens.map(({ token }) => token),
        notification: { title: message.title, body: message.body },
        data: message.data,
      });
      const invalidTokens = response.responses.flatMap((result, index) =>
        result.success || !result.error || !this.isInvalidTokenError(result.error.code)
          ? []
          : [tokens[index].token],
      );
      if (invalidTokens.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
      }
      if (response.failureCount > 0) {
        this.logger.warn(
          `FCM delivered ${response.successCount}/${tokens.length} messages for ${employeeId}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown Firebase error';
      this.logger.error(`FCM send failed for ${employeeId}: ${detail}`);
    }
  }

  private isInvalidTokenError(code: string): boolean {
    return (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    );
  }
}
