/**
 * global guard: every route requires a valid session cookie — or, for what
 * cannot sign in, an API key — unless it is marked @Public(). the resolved user is attached to the request so handlers/decorators
 * can read it. throwing UnauthorizedError yields a 401, which the web client
 * turns into a redirect to the login screen.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '@syncle/core';
import { AuthService } from './auth.service';
import { ApiKeyService, type ApiKeyIdentity } from './api-key.service';
import { IS_PUBLIC } from './public.decorator';
import { SESSION_ONLY } from './session-only.decorator';

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
    const req = http.getRequest<Request & { user?: unknown; apiKey?: ApiKeyIdentity }>();

    const session = await this.auth.sessionFromRequest(req);
    const user = session?.user ?? null;
    if (session) {
      req.user = session.user;
      // using the app IS the activity the timeout counts from
      await this.auth.renewIfDue(http.getResponse<Response>(), session).catch(() => undefined);
    }

    if (isPublic) return true;
    if (user) return true;

    // no session: an API key, for what cannot sign in
    const key = await this.apiKeys.identify(req.headers?.authorization);
    if (!key) throw new UnauthorizedError();
    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (sessionOnly) {
      throw new ForbiddenError('This is done signed in, not with an API key: a key cannot manage keys, the password or sessions.');
    }
    if (key.scope === 'read' && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      throw new ForbiddenError(`The API key "${key.name}" is read-only: it may GET, and this is a ${req.method.toUpperCase()}.`);
    }
    req.apiKey = key;
    return true;
  }
}
