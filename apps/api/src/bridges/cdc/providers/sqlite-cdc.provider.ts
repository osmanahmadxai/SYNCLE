/**
 * SQLite has no event-based CDC for external writers.
 *
 * `sqlite3_update_hook` only fires for writes made through the *same in-process
 * connection handle*. Syncle opens a database file that a *different*
 * process writes to, so it can never see those writes via the hook, and there's
 * no public WAL-tailing API that yields logical row changes. so we report
 * `supported: false` and steer the user to the polling (watch) trigger, which
 * works fine for SQLite.
 */
import { Injectable } from '@nestjs/common';
import type { CdcReadiness, DatabaseEngine } from '@syncle/core';
import type { CdcProvider, CdcStreamContext, CdcStreamHandle } from '../cdc-provider';

@Injectable()
export class SqliteCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'sqlite';

  cursorAfter(): boolean {
    return true;
  }

  async readiness(): Promise<CdcReadiness> {
    return {
      engine: 'sqlite',
      supported: false,
      ready: false,
      checks: [],
      instructions: [
        'SQLite does not support event-based change capture for external writers. Use the Polling trigger instead — it works reliably for SQLite.',
      ],
    };
  }

  async provision(): Promise<void> {
    /* no-op */
  }
  async deprovision(): Promise<void> {
    /* no-op */
  }

  async startStream(_ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    throw new Error(
      'SQLite does not support event-based delivery. Use the Polling trigger instead.',
    );
  }
}
