import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENCRYPTED_COLUMNS, KeyRotationService } from './key-rotation.service';

describe('every ciphertext there is', () => {
  it('is on the list the rotation works through: a column that is forgotten stays under a key somebody then throws away', () => {
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    const found: string[] = [];
    let model = '';
    for (const line of schema.split('\n')) {
      const start = /^model\s+(\w+)\s*\{/.exec(line);
      if (start) model = start[1]!;
      const field = /^\s+(\w+Enc)\s+String/.exec(line);
      if (field && model)
        found.push(`${model[0]!.toLowerCase()}${model.slice(1)}.${field[1]}`);
    }
    expect(found.sort()).toEqual(
      ENCRYPTED_COLUMNS.map(([m, c]) => `${m}.${c}`).sort(),
    );
    // (the one ciphertext that is NOT a column of its own — `authEnc` inside a job's
    // config snapshot — is handled by name in rotate(), and tested against a real database)
  });
});

describe('rotate', () => {
  function rig(
    rows: Record<string, Array<Record<string, string | null>>>,
    jobs: Array<{ id: string; configSnapshotJson: string }> = [],
  ) {
    const crypto = {
      previousKeys: () => [Buffer.alloc(32)],
      // "old:<x>" is under the previous key, "new:<x>" under the current one, anything else under neither
      reencrypt: (c: string) => {
        if (c.startsWith('old:')) return `new:${c.slice(4)}`;
        if (c.startsWith('new:')) return null;
        throw new Error('no key fits');
      },
    };
    const updates: string[] = [];
    const delegate = (model: string) => ({
      findMany: async () => rows[model] ?? [],
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, string>;
      }) => {
        Object.assign(
          (rows[model] ?? []).find((r) => r.id === where.id)!,
          data,
        );
        updates.push(`${model}.${where.id}.${Object.keys(data)[0]}`);
      },
    });
    const prisma = {
      connection: delegate('connection'),
      bridge: delegate('bridge'),
      alertChannel: delegate('alertChannel'),
      bridgeJob: {
        findMany: async () => jobs,
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { configSnapshotJson: string };
        }) => {
          jobs.find((j) => j.id === where.id)!.configSnapshotJson =
            data.configSnapshotJson;
          updates.push(`bridgeJob.${where.id}`);
        },
      },
    };
    return {
      service: new KeyRotationService(prisma as never, crypto as never),
      updates,
      rows,
      jobs,
    };
  }

  it('moves what is under a previous key, leaves alone what is not, and counts what no key fits', async () => {
    const r = rig(
      {
        connection: [
          {
            id: 'c1',
            passwordEnc: 'old:pw',
            connectionStringEnc: null,
            sshSecretsEnc: 'new:ssh',
            tlsSecretsEnc: null,
          },
          {
            id: 'c2',
            passwordEnc: 'garbage',
            connectionStringEnc: 'old:url',
            sshSecretsEnc: null,
            tlsSecretsEnc: 'old:tls',
          },
        ],
        bridge: [
          { id: 'b1', authEnc: 'old:token' },
          { id: 'b2', authEnc: null },
        ],
        alertChannel: [{ id: 'a1', configEnc: 'old:cfg' }],
      },
      [
        {
          id: 'j1',
          configSnapshotJson: JSON.stringify({
            name: 'x',
            authEnc: 'old:token',
            delivery: { a: 1 },
          }),
        },
        {
          id: 'j2',
          configSnapshotJson: JSON.stringify({ name: 'y', authEnc: null }),
        },
        { id: 'j3', configSnapshotJson: 'not json, but mentions "authEnc":"' },
      ],
    );
    const report = await r.service.rotate();
    expect(report).toMatchObject({
      previousKeys: 1,
      reencrypted: 6,
      unreadable: 1,
    });
    expect(r.updates.sort()).toEqual([
      'alertChannel.a1.configEnc',
      'bridge.b1.authEnc',
      'bridgeJob.j1',
      'connection.c1.passwordEnc',
      'connection.c2.connectionStringEnc',
      'connection.c2.tlsSecretsEnc',
    ]);
    expect(r.rows.connection![1]!.passwordEnc).toBe('garbage'); // not touched
    // the rest of a snapshot is exactly what it was
    expect(JSON.parse(r.jobs[0]!.configSnapshotJson)).toEqual({
      name: 'x',
      authEnc: 'new:token',
      delivery: { a: 1 },
    });
    expect(r.service.status()).toEqual(report);

    // a second pass finds nothing to do
    expect(await r.service.rotate()).toMatchObject({
      reencrypted: 0,
      unreadable: 1,
    });
  });
});
