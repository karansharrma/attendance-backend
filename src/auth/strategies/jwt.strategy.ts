import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, JwtPayload } from '../auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    // Access and refresh tokens are signed with different secrets, but check the claim too:
    // it makes the intent explicit and survives someone unifying the secrets later.
    if (payload.tokenType !== 'access') {
      throw new UnauthorizedException('A refresh token cannot be used to access resources');
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
