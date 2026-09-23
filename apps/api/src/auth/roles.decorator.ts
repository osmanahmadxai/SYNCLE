import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@syncle/core';

export const ROLES = 'roles';

/**
 * only accounts with one of these roles may call this. what it says is about
 * ACCOUNTS: an API key is not one, and keeps its own rule (its scope). a route
 * that only an account may call at all is marked @SessionOnly() beside it
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);
