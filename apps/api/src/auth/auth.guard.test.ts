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
  /** who `Authorization: Bearer …` turns out to be */
  apiKey?: { id: string; name: string; scope: 'read' | 'full' } | null;
  sessionOnly?: boolean;
  /** the roles the route is marked with (@Roles) */
  roles?: string[];
}) {
  const auth = {
    sessionFromRequest: vi.fn(async () => opts.session),
    renewIfDue: vi.fn(async () => {
      if (opts.renewFails) throw new Error('cannot set headers');
      return true;
    }),
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) =>
      key === 'auth:session-only'
        ? !!opts.sessionOnly
        : key === 'roles'
          ? opts.roles
          : opts.isPublic,
    ),
  };
  const apiKeys = { identify: vi.fn(async () => opts.apiKey ?? null) };
  return {
    guard: new AuthGuard(auth as never, reflector as never, apiKeys as never),
    auth,
    apiKeys,
  };
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

  describe('with an API key instead of a session', () => {
    const key = { id: 'k1', name: 'ci', scope: 'full' as const };
    const request = (method: string) =>
      ({ method, headers: { authorization: 'Bearer syn_x' } }) as Record<
        string,
        unknown
      >;

    it('lets a known key through, and says which key it was', async () => {
      const { guard, apiKeys } = make({
        isPublic: false,
        session: null,
        apiKey: key,
      });
      const req = request('POST');
      await expect(guard.canActivate(contextWith(req))).resolves.toBe(true);
      expect(apiKeys.identify).toHaveBeenCalledWith('Bearer syn_x');
      expect(req.apiKey).toEqual(key);
      // a key is not a person: nothing pretends to be the signed-in user
      expect(req.user).toBeUndefined();
    });

    it('an unknown, revoked or expired key is no credential at all', async () => {
      const { guard } = make({ isPublic: false, session: null, apiKey: null });
      await expect(
        guard.canActivate(contextWith(request('GET'))),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('a read key may GET and HEAD, and nothing else — whatever the route does', async () => {
      const { guard } = make({
        isPublic: false,
        session: null,
        apiKey: { ...key, scope: 'read' },
      });
      await expect(
        guard.canActivate(contextWith(request('GET'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(contextWith(request('head'))),
      ).resolves.toBe(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await expect(
          guard.canActivate(contextWith(request(method))),
          method,
        ).rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining('read-only'),
        });
      }
    });

    it('no key, of any scope, reaches what concerns credentials — not even to look', async () => {
      const { guard } = make({
        isPublic: false,
        session: null,
        apiKey: key,
        sessionOnly: true,
      });
      for (const method of ['GET', 'POST', 'DELETE']) {
        await expect(
          guard.canActivate(contextWith(request(method))),
          method,
        ).rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining('not with an API key'),
        });
      }
    });

    it('a session wins: the key is not even looked at', async () => {
      const session = { user: { id: 'u1' }, ageSec: 10 };
      const { guard, apiKeys } = make({
        isPublic: false,
        session,
        apiKey: null,
        sessionOnly: true,
      });
      await expect(
        guard.canActivate(contextWith(request('DELETE'))),
      ).resolves.toBe(true);
      expect(apiKeys.identify).not.toHaveBeenCalled();
    });
  });

  describe('what an account’s role allows', () => {
    const session = (role: string | undefined) => ({
      user: { id: 'u1', username: 'sam', role },
      ageSec: 10,
    });
    const request = (method: string, url: string) =>
      ({ method, originalUrl: url, headers: {} }) as Record<string, unknown>;

    it('a route for admins turns an operator away, by name and role', async () => {
      const { guard } = make({
        isPublic: false,
        session: session('operator'),
        roles: ['admin'],
      });
      await expect(
        guard.canActivate(contextWith(request('GET', '/api/auth/users'))),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(
          /takes the admin role.*"sam" is an operator/,
        ),
      });
      const admin = make({
        isPublic: false,
        session: session('admin'),
        roles: ['admin'],
      });
      await expect(
        admin.guard.canActivate(contextWith(request('GET', '/api/auth/users'))),
      ).resolves.toBe(true);
    });

    it('a viewer may look, and change nothing — except their own password and session', async () => {
      const { guard } = make({ isPublic: false, session: session('viewer') });
      await expect(
        guard.canActivate(contextWith(request('GET', '/api/bridges?x=1'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(contextWith(request('HEAD', '/api/bridges'))),
      ).resolves.toBe(true);
      for (const [method, url] of [
        ['POST', '/api/bridges'],
        ['PUT', '/api/connections/c1'],
        ['DELETE', '/api/bridges/b1'],
        ['PATCH', '/api/connections/c1/rows'],
        ['POST', '/api/auth/users'],
      ]) {
        await expect(
          guard.canActivate(contextWith(request(method!, url!))),
          `${method} ${url}`,
        ).rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining('is a viewer'),
        });
      }
      await expect(
        guard.canActivate(
          contextWith(request('POST', '/api/auth/change-password')),
        ),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(contextWith(request('POST', '/api/auth/logout?x=1'))),
      ).resolves.toBe(true);
      // (the self-service paths, not something that starts like them)
      await expect(
        guard.canActivate(contextWith(request('POST', '/api/auth/logout-all'))),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('an operator does everything a route does not reserve for admins', async () => {
      const { guard } = make({ isPublic: false, session: session('operator') });
      await expect(
        guard.canActivate(contextWith(request('POST', '/api/bridges'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(
          contextWith(request('DELETE', '/api/connections/c1')),
        ),
      ).resolves.toBe(true);
    });

    it('an account from before there were roles is an admin', async () => {
      const { guard } = make({
        isPublic: false,
        session: session(undefined),
        roles: ['admin'],
      });
      await expect(
        guard.canActivate(contextWith(request('POST', '/api/auth/users'))),
      ).resolves.toBe(true);
    });

    it('roles are about accounts: a key’s scope decides for a key, as before', async () => {
      const key = { id: 'k1', name: 'ci', scope: 'full' as const };
      const { guard } = make({
        isPublic: false,
        session: null,
        apiKey: key,
        roles: ['admin'],
      });
      const req = {
        method: 'PUT',
        originalUrl: '/api/settings',
        headers: { authorization: 'Bearer syn_x' },
      } as Record<string, unknown>;
      await expect(guard.canActivate(contextWith(req))).resolves.toBe(true);
    });
  });
});
