import { Body, Controller, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, LoginResponse } from './auth.service';
import { AuthenticatedUser, TokenPair } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LoginDto } from './dto/login.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Throttled far harder than the rest of the API: this is the only endpoint where an
   * attacker gets unlimited free guesses at a credential.
   */
  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Ip() ip: string): Promise<LoginResponse> {
    return this.authService.login(dto, ip);
  }

  /**
   * Public in the sense that no *access* token is needed -- the refresh token in the body is
   * the credential, and JwtRefreshGuard validates it.
   */
  @Public()
  @UseGuards(JwtRefreshGuard)
  @Throttle({ auth: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body() _dto: RefreshTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TokenPair> {
    return this.authService.refresh(user);
  }
}
