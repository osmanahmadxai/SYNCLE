/**
 * global guard: every route requires a valid session cookie — or, for what
 * cannot sign in, an API key — unless it is marked @Public(). the resolved user is attached to the request so handlers/decorators
 * can read it. throwing UnauthorizedError yields a 401, which the web client
 * turns into a redirect to the login screen.
 *
 * an account also has a ROLE (core's userRoleSchema): a route marked
 * @Roles(...) takes only those, and a viewer may only look — every GET, and
 * nothing that changes anything except their own password. an API key is not
 * an account: its scope says what it may do, as before.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { AppUser } from '@prisma/client';
import { ForbiddenError, UnauthorizedError, type UserRole } from '@syncle/core';
import { AuthService } from './auth.service';
import { ApiKeyService, type ApiKeyIdentity } from './api-key.service';
import { IS_PUBLIC } from './public.decorator';
import { ROLES } from './roles.decorator';
import { SESSION_ONLY } from './session-only.decorator';

/** what a viewer may do besides look: things about their own session */
const SELF_SERVICE = new Set(['/auth/logout', '/auth/change-password']);

export const roleOf = (user: Pick<AppUser, 'role'>): UserRole =>
  user.role === 'operator' || user.role === 'viewer' ? user.role : 'admin';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & { user?: unknown; apiKey?: ApiKeyIdentity }
    >();

    const session = await this.auth.sessionFromRequest(req);
    const user = session?.user ?? null;
    if (session) {
      req.user = session.user;
      // using the app IS the activity the timeout counts from
      await this.auth
        .renewIfDue(http.getResponse<Response>(), session)
        .catch(() => undefined);
    }

    if (isPublic) return true;
    if (user) {
      this.assertRole(context, req, user);
      return true;
    }

    // no session: an API key, for what cannot sign in
    const key = await this.apiKeys.identify(req.headers?.authorization);
    if (!key) throw new UnauthorizedError();
    const sessionOnly = this.reflector.getAllAndOverride<boolean>(
      SESSION_ONLY,
      [context.getHandler(), context.getClass()],
    );
    if (sessionOnly) {
      throw new ForbiddenError(
        'This is done signed in, not with an API key: a key cannot manage keys, accounts, the password or sessions.',
      );
    }
    if (
      key.scope === 'read' &&
      !['GET', 'HEAD'].includes(req.method.toUpperCase())
    ) {
      throw new ForbiddenError(
        `The API key "${key.name}" is read-only: it may GET, and this is a ${req.method.toUpperCase()}.`,
      );
    }
    req.apiKey = key;
    return true;
  }

  /** what the account's role allows here */
  private assertRole(
    context: ExecutionContext,
    req: Request,
    user: AppUser,
  ): void {
    const role = roleOf(user);
    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (allowed && !allowed.includes(role)) {
      throw new ForbiddenError(
        `This takes the ${allowed.join(' or ')} role; the account "${user.username}" is ${article(role)} ${role}.`,
      );
    }
    if (role !== 'viewer') return;
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;
    if (SELF_SERVICE.has(routePath(req))) return;
    throw new ForbiddenError(
      `The account "${user.username}" is a viewer: it may look, not change anything. Ask an admin for the operator role.`,
    );
  }
}

/** the route's path without the query string and without the API's prefix */
export function routePath(req: Pick<Request, 'originalUrl' | 'url'>): string {
  const path = (req.originalUrl || req.url || '').split('?')[0] ?? '';
  return path.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
}

const article = (role: string): string => (/^[aeiou]/i.test(role) ? 'an' : 'a');
