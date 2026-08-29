import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../auth.types';

/**
 * Runs after JwtAuthGuard. A route with no @Roles metadata is open to any authenticated
 * user; /admin/* controllers carry @Roles(Role.ADMIN) at the class level.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return false;

    if (!required.includes(user.role)) {
      throw new ForbiddenException('This endpoint requires one of: ' + required.join(', '));
    }
    return true;
  }
}
