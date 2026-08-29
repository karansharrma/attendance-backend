import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the globally applied JWT guard.
 *
 * Authentication is on by default and switched off explicitly, rather than the reverse: a
 * forgotten decorator then fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
