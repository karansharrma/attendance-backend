import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterPushTokenDto {
  /** FCM registration token returned by Firebase Messaging in the app or browser. */
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token!: string;

  @IsIn(['android', 'ios', 'web'])
  platform!: 'android' | 'ios' | 'web';
}
