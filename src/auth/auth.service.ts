import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { Employee, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser, JwtPayload, TokenPair } from './auth.types';
import { LoginDto } from './dto/login.dto';

export interface LoginResponse extends TokenPair {
  employee: {
    id: string;
    name: string;
    email: string;
    role: Role;
    isUnrestricted: boolean;
  };
}

/**
 * Refresh tokens here are **stateless**: signed with their own secret and a `tokenType`
 * claim, with no server-side record. That keeps the schema exactly as specified, at the cost
 * of not being able to revoke an individual refresh token before it expires. If revocation
 * matters for your deployment, add a RefreshToken table storing a bcrypt hash of the issued
 * token plus employeeId, check it in `refresh()`, and rotate on every use. The rest of this
 * service does not change.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto, ipAddress?: string): Promise<LoginResponse> {
    const employee = await this.prisma.employee.findUnique({ where: { email: dto.email } });

    // Compare against a dummy hash when the account does not exist, so a missing user and a
    // wrong password take the same amount of time and cannot be told apart by an attacker.
    const hash = employee?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(dto.password, hash);

    if (!employee || !passwordMatches) {
      this.logger.warn(`Failed login for ${dto.email} from ${ipAddress ?? 'unknown ip'}`);
      throw new UnauthorizedException('Invalid email or password');
    }

    this.logger.log(`Login succeeded for ${employee.id} (${employee.role})`);
    return { ...(await this.issueTokens(employee)), employee: this.publicProfile(employee) };
  }

  /**
   * Issues a fresh access token from a valid refresh token, and rotates the refresh token
   * alongside it so a long-lived device does not hold one credential forever.
   */
  async refresh(user: AuthenticatedUser): Promise<TokenPair> {
    const employee = await this.prisma.employee.findUnique({ where: { id: user.sub } });
    if (!employee) {
      // The account was deleted after the token was issued.
      throw new UnauthorizedException('Account no longer exists');
    }
    this.logger.log(`Refreshed tokens for ${employee.id}`);
    return this.issueTokens(employee);
  }

  private async issueTokens(employee: Employee): Promise<TokenPair> {
    const base = { sub: employee.id, email: employee.email, role: employee.role };

    const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d');

    // jsonwebtoken types `expiresIn` as a narrow string-literal union ("15m", "30d", ...),
    // which a value read from the environment can never satisfy statically. The format is
    // validated by jsonwebtoken at sign time, so the cast is the honest way to express it.
    const accessOptions = {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessExpiresIn,
    } as JwtSignOptions;
    const refreshOptions = {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    } as JwtSignOptions;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ ...base, tokenType: 'access' } satisfies JwtPayload, accessOptions),
      this.jwt.signAsync({ ...base, tokenType: 'refresh' } satisfies JwtPayload, refreshOptions),
    ]);

    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: accessExpiresIn };
  }

  private publicProfile(employee: Employee): LoginResponse['employee'] {
    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      isUnrestricted: employee.isUnrestricted,
    };
  }
}

/**
 * A real bcrypt hash of a value nobody knows, used only to equalise timing on the
 * unknown-email path. Cost 10 matches what the seed and enrollment paths use.
 */
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
