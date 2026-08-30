import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

export interface DeviceConfig {
  faceMatchThreshold: number;
  embeddingModelVersion: string;
  maxLocationAccuracyMeters: number;
  lateArrivalCutoffMinutes: number;
  maxSyncBatchSize: number;
}

/**
 * Remote-tunable knobs the device caches locally.
 *
 * Beyond the endpoint list in the build spec, but the values it serves are meaningless
 * without somewhere to read them: the Android client applies the face-match threshold
 * on-device and needs to be able to pick up a change without an app release. Authenticated,
 * because a threshold is an attacker-useful hint about how the match gate is tuned.
 */
@Controller('config')
@SkipThrottle({ auth: true })
export class DeviceConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  get(): DeviceConfig {
    return {
      faceMatchThreshold: this.config.get<number>('FACE_MATCH_THRESHOLD', 0.75),
      embeddingModelVersion: this.config.get<string>('EMBEDDING_MODEL_VERSION', 'mobilefacenet-v1'),
      maxLocationAccuracyMeters: this.config.get<number>('MAX_LOCATION_ACCURACY_METERS', 30),
      lateArrivalCutoffMinutes: this.config.get<number>('LATE_ARRIVAL_CUTOFF_MINUTES', 555),
      maxSyncBatchSize: this.config.get<number>('MAX_SYNC_BATCH_SIZE', 200),
    };
  }
}
