/**
 * moves every stored secret from a PREVIOUS master key to the current one.
 *
 * Changing the key is: start with the new key as SYNCLE_MASTER_KEY and the old
 * one as SYNCLE_MASTER_KEY_PREVIOUS. from that moment everything is readable
 * (CryptoService tries both), and this runs at start and re-encrypts what is
 * still under the old key. when it reports nothing left, the old key can be
 * taken out of the environment — and until then, nothing depends on this
 * having finished: it can be interrupted, repeated, or never run.
 *
 * every place a ciphertext lives is listed HERE. a new encrypted column has to
 * be added to it, and a test compares this list with the Prisma schema so that
 * one that is forgotten fails the build instead of being left behind under a
 * key somebody then throws away.
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';

/** [prisma model, column] of every column that holds a ciphertext */
export const ENCRYPTED_COLUMNS = [
  ['connection', 'passwordEnc'],
  ['connection', 'connectionStringEnc'],
  ['connection', 'sshSecretsEnc'],
  ['connection', 'tlsSecretsEnc'],
  ['bridge', 'authEnc'],
  ['alertChannel', 'configEnc'],
] as const;

export interface KeyRotationReport {
  /** previous keys this instance has been given */
  previousKeys: number;
  /** secrets that were under a previous key and are now under the current one */
  reencrypted: number;
  /** secrets no key fits: left exactly as they are, and said */
  unreadable: number;
  checkedAt: string;
}

type Delegate = {
  findMany(args: {
    select: Record<string, true>;
  }): Promise<Array<Record<string, string | null>>>;
  update(args: {
    where: { id: string };
    data: Record<string, string>;
  }): Promise<unknown>;
};

@Injectable()
export class KeyRotationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('KeyRotation');
  private last: KeyRotationReport | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (this.crypto.previousKeys().length === 0) return;
      const report = await this.rotate();
      if (report.unreadable > 0) {
        this.logger.error(
          `${report.unreadable} stored secret(s) cannot be read with the current key or any previous one. They were left as they are. ` +
            'Is a key missing from SYNCLE_MASTER_KEY_PREVIOUS?',
        );
      }
      this.logger.log(
        report.reencrypted > 0
          ? `Re-encrypted ${report.reencrypted} stored secret(s) with the current master key.`
          : 'Every stored secret is under the current master key.',
      );
      if (report.unreadable === 0) {
        this.logger.log(
          'Nothing depends on a previous master key any more: SYNCLE_MASTER_KEY_PREVIOUS can be removed.',
        );
      }
    } catch (err) {
      // never a reason not to start: everything is still readable with both keys
      this.logger.error(
        `Could not re-encrypt stored secrets: ${(err as Error).message}`,
      );
    }
  }

  status(): KeyRotationReport {
    return (
      this.last ?? {
        previousKeys: this.crypto.previousKeys().length,
        reencrypted: 0,
        unreadable: 0,
        checkedAt: new Date().toISOString(),
      }
    );
  }

  /** idempotent: what is under the current key already is not touched */
  async rotate(): Promise<KeyRotationReport> {
    const report: KeyRotationReport = {
      previousKeys: this.crypto.previousKeys().length,
      reencrypted: 0,
      unreadable: 0,
      checkedAt: new Date().toISOString(),
    };
    const turn = (ciphertext: string): string | null => {
      try {
        const next = this.crypto.reencrypt(ciphertext);
        if (next) report.reencrypted++;
        return next;
      } catch {
        report.unreadable++;
        return null;
      }
    };

    for (const [model, column] of ENCRYPTED_COLUMNS) {
      const delegate = (this.prisma as unknown as Record<string, Delegate>)[
        model
      ]!;
      // (no `not: null` filter: Prisma refuses it on a column that cannot be null, and these tables are small)
      const rows = await delegate.findMany({
        select: { id: true, [column]: true },
      });
      for (const row of rows) {
        if (!row[column]) continue;
        const next = turn(row[column]!);
        if (next)
          await delegate.update({
            where: { id: row.id! },
            data: { [column]: next },
          });
      }
    }

    // a job keeps the bridge as it was when the job began — with the secret still
    // encrypted, INSIDE the JSON. a replay that is resumed next month decrypts it
    const jobs = await this.prisma.bridgeJob.findMany({
      where: { configSnapshotJson: { contains: '"authEnc":"' } },
      select: { id: true, configSnapshotJson: true },
    });
    for (const job of jobs) {
      try {
        const snapshot = JSON.parse(job.configSnapshotJson) as {
          authEnc?: string | null;
        };
        if (typeof snapshot.authEnc !== 'string' || !snapshot.authEnc) continue;
        const next = turn(snapshot.authEnc);
        if (!next) continue;
        snapshot.authEnc = next;
        await this.prisma.bridgeJob.update({
          where: { id: job.id },
          data: { configSnapshotJson: JSON.stringify(snapshot) },
        });
      } catch {
        /* a snapshot that is not JSON holds no secret to move */
      }
    }
    this.last = report;
    return report;
  }
}
