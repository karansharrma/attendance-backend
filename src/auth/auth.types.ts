import { Role } from '@prisma/client';

/** Claims carried by both token kinds. `sub` is the employee id. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tokenType: 'access' | 'refresh';
}

/** What the guards attach to `request.user`. */
export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
}
