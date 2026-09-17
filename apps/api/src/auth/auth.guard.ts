/**
 * global guard: every route requires a valid session cookie unless it is marked
 * @Public(). the resolved user is attached to the request so handlers/decorators
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
import { UnauthorizedError } from '@syncle/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: unknown }>();

    const session = await this.auth.sessionFromRequest(req);
    const user = session?.user ?? null;
    if (session) {
      req.user = session.user;
      // using the app IS the activity the timeout counts from
      await this.auth.renewIfDue(http.getResponse<Response>(), session).catch(() => undefined);
    }

    if (isPublic) return true;
    if (!user) throw new UnauthorizedError();
    return true;
  }
}
