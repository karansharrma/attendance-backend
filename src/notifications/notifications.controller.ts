import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Call after FCM returns a token and again whenever Firebase rotates it. */
  @Post('devices')
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterPushTokenDto) {
    return this.notifications.registerToken(user.sub, dto);
  }

  /** Call when the user signs out or revokes web/mobile notification permission. */
  @Delete('devices/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.notifications.unregisterToken(user.sub, token);
  }

  @Roles(Role.ADMIN)
  @Get('preferences')
  preferences(@CurrentUser() admin: AuthenticatedUser) {
    return this.notifications.getPreferences(admin.sub);
  }

  @Roles(Role.ADMIN)
  @Patch('preferences')
  preferencesUpdate(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(admin.sub, dto);
  }
}
