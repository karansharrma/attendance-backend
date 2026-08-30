import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  controllers: [SitesController],
  imports: [NotificationsModule],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
