import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, JwtPayload } from '../auth.types';

/**
 * Reads the refresh token from the JSON body rather than the Authorization header, so a
 * client cannot accidentally send it on every request and leak it into access logs.
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromBodyField('refreshToken'),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('That is not a refresh token');
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
