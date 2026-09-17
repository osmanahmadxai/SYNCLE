/**
 * bridges as a file, and back: export, import, clone.
 *
 * What travels is configuration. What does not is anything secret: an HTTP
 * destination's token or header value leaves EMPTY (never as the `********` the
 * API shows in its place — imported, that would become the token), and a
 * connection is a reference: its id, with its name and engine beside it so that
 * another instance can find its own.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BRIDGE_EXPORT_FORMAT,
  BadRequestError,
  DEFAULT_WORKSPACE_ID,
  bridgeInputSchema,
  type Bridge,
  type BridgeDestination,
  type BridgeExportDocument,
  type BridgeImportDTO,
  type BridgeImportResult,
  type BridgeInputDTO,
  type UnresolvedConnection,
} from '@syncle/core';
import { PrismaService } from '../common/prisma.service';
import { resolveVersion } from '../common/version';
import { BridgeStoreService } from './bridge-store.service';

/** every connection id a bridge's configuration refers to */
export function connectionIdsOf(
  bridge: Pick<BridgeInputDTO, 'source' | 'destination'>,
): string[] {
  const ids = [bridge.source.connectionId];
  if (bridge.destination.kind === 'database')
    ids.push(...bridge.destination.targets.map((t) => t.connectionId));
  return [...new Set(ids)];
}

/** the destination with nothing secret in it: an empty credential, not a masked one */
export function withoutSecrets(
  destination: BridgeDestination,
): BridgeDestination {
  if (destination.kind !== 'http') return destination;
  const auth = destination.auth;
  if (auth.type === 'bearer')
    return { ...destination, auth: { type: 'bearer', token: '' } };
  if (auth.type === 'header')
    return {
      ...destination,
      auth: { type: 'header', name: auth.name, value: '' },
    };
  return destination;
}

/** true when an HTTP destination wants a credential it does not have */
function credentialMissing(destination: BridgeDestination): boolean {
  if (destination.kind !== 'http') return false;
  const auth = destination.auth;
  return (
    (auth.type === 'bearer' && !auth.token) ||
    (auth.type === 'header' && !auth.value)
  );
}

function remap(
  bridge: BridgeInputDTO,
  map: Map<string, string>,
): BridgeInputDTO {
  const to = (id: string): string => map.get(id) ?? id;
  return {
    ...bridge,
    source: { ...bridge.source, connectionId: to(bridge.source.connectionId) },
    destination:
      bridge.destination.kind === 'database'
        ? {
            ...bridge.destination,
            targets: bridge.destination.targets.map((t) => ({
              ...t,
              connectionId: to(t.connectionId),
            })),
          }
        : bridge.destination,
  };
}

/**
 * a bridge that arrives by import, or is made as a copy, keeps its schedule —
 * switched off. a file dropped onto production must not start writing at two in
 * the morning because staging did, and a copy made in order to be changed must
 * not run beside its original, into the same table, before it has been
 */
export function withScheduleOff<T extends BridgeInputDTO['trigger']>(
  trigger: T,
): { trigger: T; wasOn: boolean } {
  if (trigger.kind !== 'replay' || !trigger.schedule?.enabled)
    return { trigger, wasOn: false };
  return {
    trigger: { ...trigger, schedule: { ...trigger.schedule, enabled: false } },
    wasOn: true,
  };
}

@Injectable()
export class BridgeTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
  ) {}

  private toInput(bridge: Bridge): BridgeInputDTO {
    // through the schema: what is exported is exactly what an import accepts
    return bridgeInputSchema.parse({
      name: bridge.name,
      source: bridge.source,
      destination: withoutSecrets(bridge.destination),
      transform: bridge.transform,
      delivery: bridge.delivery,
      trigger: bridge.trigger,
      enabled: bridge.enabled,
    });
  }

  async export(bridges: Bridge[]): Promise<BridgeExportDocument> {
    if (bridges.length === 0)
      throw new BadRequestError('There is no bridge to export.');
    const inputs = bridges.map((b) => this.toInput(b));
    const ids = [...new Set(inputs.flatMap(connectionIdsOf))];
    const rows = await this.prisma.connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, engine: true },
    });
    return {
      format: BRIDGE_EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      syncleVersion: resolveVersion().version,
      // name and engine ONLY: where a connection points, and with what
      // credentials, is not part of a bridge and does not leave with one
      connections: Object.fromEntries(
        rows.map((r) => [r.id, { name: r.name, engine: r.engine }]),
      ),
      bridges: inputs,
    };
  }

  async exportOne(id: string): Promise<BridgeExportDocument> {
    return this.export([await this.store.get(id)]);
  }

  async exportWorkspace(workspaceId?: string): Promise<BridgeExportDocument> {
    return this.export(await this.store.list(workspaceId));
  }

  /**
   * which connection of THIS instance each connection of the document is: the
   * one the caller says, else the same id (a re-import into the instance it
   * came from), else the only connection here with that name and engine.
   * anything else is for a person to decide, and is returned as unresolved.
   */
  private async resolveConnections(
    dto: BridgeImportDTO,
    workspaceId: string,
  ): Promise<{ map: Map<string, string>; unresolved: UnresolvedConnection[] }> {
    const wanted = [...new Set(dto.document.bridges.flatMap(connectionIdsOf))];
    const local = await this.prisma.connection.findMany({
      where: { workspaceId },
      select: { id: true, name: true, engine: true },
    });
    const everywhere = await this.prisma.connection.findMany({
      select: { id: true },
    });
    const exists = new Set(everywhere.map((c) => c.id));
    const map = new Map<string, string>();
    const unresolved: UnresolvedConnection[] = [];

    for (const id of wanted) {
      const said = dto.connectionMap?.[id];
      if (said) {
        if (!exists.has(said))
          throw new BadRequestError(
            `The connection "${said}" the import maps to does not exist.`,
          );
        map.set(id, said);
        continue;
      }
      if (exists.has(id)) {
        map.set(id, id);
        continue;
      }
      const described = dto.document.connections[id];
      const sameName = described
        ? local.filter(
            (c) => c.name === described.name && c.engine === described.engine,
          )
        : [];
      if (sameName.length === 1) {
        map.set(id, sameName[0]!.id);
        continue;
      }
      unresolved.push({
        id,
        name: described?.name ?? id,
        engine: described?.engine ?? 'unknown',
        candidates: local
          .filter((c) => !described || c.engine === described.engine)
          .map((c) => ({ id: c.id, name: c.name })),
      });
    }
    return { map, unresolved };
  }

  async import(dto: BridgeImportDTO): Promise<BridgeImportResult> {
    const workspaceId = dto.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const { map, unresolved } = await this.resolveConnections(dto, workspaceId);
    if (unresolved.length > 0) {
      throw new BadRequestError(
        `${unresolved.length === 1 ? 'A connection' : `${unresolved.length} connections`} of this file ${unresolved.length === 1 ? 'has' : 'have'} no counterpart here: ` +
          `${unresolved.map((u) => `"${u.name}" (${u.engine})`).join(', ')}. Say which connection to use for each.`,
        { reason: 'unresolved-connections', unresolved },
      );
    }

    const taken = new Set(
      (
        await this.prisma.bridge.findMany({
          where: { workspaceId },
          select: { name: true },
        })
      ).map((b) => b.name),
    );
    const created: BridgeImportResult['created'] = [];
    const warnings: string[] = [];

    // everything is checked before anything is created: half an import is
    // worse than none
    const prepared = dto.document.bridges.map((original) => {
      const bridge = remap(original, map);
      let name = bridge.name;
      for (let n = 2; taken.has(name); n++)
        name = `${bridge.name} (imported${n > 2 ? ` ${n - 1}` : ''})`;
      taken.add(name);
      const needsCredential = credentialMissing(bridge.destination);
      if (needsCredential) {
        warnings.push(
          `"${name}" posts to an endpoint that wants a credential, and credentials are not exported: it was imported switched off. Set the credential, then enable it.`,
        );
      }
      const { trigger, wasOn } = withScheduleOff(bridge.trigger);
      if (wasOn) {
        warnings.push(
          `"${name}" runs on a schedule (${bridge.trigger.kind === 'replay' ? bridge.trigger.schedule?.cron : ''}): it was imported with the schedule switched off. Look it over, then turn the schedule on.`,
        );
      }
      return {
        ...bridge,
        trigger,
        name,
        workspaceId,
        enabled: needsCredential ? false : bridge.enabled,
      };
    });
    for (const bridge of prepared) {
      const saved = await this.store.create(bridge);
      created.push({ id: saved.id, name: saved.name });
    }
    return { created, warnings };
  }

  /**
   * a copy of a bridge, in the same workspace, under a new name — credential
   * included, since it never leaves this instance. it has no job and no
   * position: a copy of a live bridge starts from scratch when it is started
   */
  async clone(id: string): Promise<Bridge> {
    const row = await this.prisma.bridge.findUnique({ where: { id } });
    if (!row) return this.store.get(id); // throws the store's own not-found
    const taken = new Set(
      (
        await this.prisma.bridge.findMany({
          where: { workspaceId: row.workspaceId },
          select: { name: true },
        })
      ).map((b) => b.name),
    );
    let name = `${row.name} (copy)`;
    for (let n = 2; taken.has(name); n++) name = `${row.name} (copy ${n})`;
    const { createdAt: _c, updatedAt: _u, ...rest } = row;
    // the copy keeps the schedule's line, switched off, and none of its history
    let triggerJson = row.triggerJson;
    if (triggerJson) {
      const { trigger } = withScheduleOff(
        JSON.parse(triggerJson) as BridgeInputDTO['trigger'],
      );
      triggerJson = JSON.stringify(trigger);
    }
    const copy = await this.prisma.bridge.create({
      data: {
        ...rest,
        id: randomUUID(),
        name,
        triggerJson,
        scheduleStateJson: null,
      },
    });
    return this.store.get(copy.id);
  }
}
