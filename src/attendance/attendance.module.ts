import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  controllers: [AttendanceController],
  imports: [NotificationsModule],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
