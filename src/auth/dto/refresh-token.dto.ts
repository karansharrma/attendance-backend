import { IsJWT } from 'class-validator';

export class RefreshTokenDto {
  @IsJWT({ message: 'refreshToken must be a valid JWT' })
  refreshToken!: string;
}
