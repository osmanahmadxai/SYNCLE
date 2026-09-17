import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

function contextWith(
  req: Record<string, unknown>,
  res: Record<string, unknown> = {},
): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function make(opts: {
  isPublic: boolean;
  session: { user: { id: string }; ageSec: number } | null;
  renewFails?: boolean;
}) {
  const auth = {
    sessionFromRequest: vi.fn(async () => opts.session),
    renewIfDue: vi.fn(async () => {
      if (opts.renewFails) throw new Error('cannot set headers');
      return true;
    }),
  };
  const reflector = { getAllAndOverride: vi.fn(() => opts.isPublic) };
  return { guard: new AuthGuard(auth as never, reflector as never), auth };
}

describe('the global auth guard', () => {
  it('refuses a request with no valid session', async () => {
    const { guard } = make({ isPublic: false, session: null });
    await expect(guard.canActivate(contextWith({}))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('lets a signed-in request through and hands the user to the handler', async () => {
    const session = { user: { id: 'u1' }, ageSec: 10 };
    const { guard, auth } = make({ isPublic: false, session });
    const req: Record<string, unknown> = {};
    const res = {};
    await expect(guard.canActivate(contextWith(req, res))).resolves.toBe(true);
    expect(req.user).toBe(session.user);
    // using the app is the activity the timeout counts from
    expect(auth.renewIfDue).toHaveBeenCalledWith(res, session);
  });

  it('lets a public route through without a session — and still says who is asking when there is one', async () => {
    const anonymous = make({ isPublic: true, session: null });
    const req: Record<string, unknown> = {};
    await expect(anonymous.guard.canActivate(contextWith(req))).resolves.toBe(
      true,
    );
    expect(req.user).toBeUndefined();

    const session = { user: { id: 'u1' }, ageSec: 10 };
    const known = make({ isPublic: true, session });
    const req2: Record<string, unknown> = {};
    await known.guard.canActivate(contextWith(req2));
    expect(req2.user).toBe(session.user);
  });

  it('a renewal that cannot be written does not turn a valid request away', async () => {
    const session = { user: { id: 'u1' }, ageSec: 99_999 };
    const { guard } = make({ isPublic: false, session, renewFails: true });
    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
  });
});
