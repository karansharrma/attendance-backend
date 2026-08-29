import { Module } from '@nestjs/common';
import { DeviceConfigController } from './device-config.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [DeviceConfigController, HealthController],
})
export class DeviceConfigModule {}
