/**
 * store for workspaces, the top-level container that owns connections and
 * bridges. there's always a default workspace (seeded by the migration and
 * re-ensured on boot) so the rest of the app can assume one exists.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit, Logger } from '@nestjs/common';
import { Prisma, type Workspace as WorkspaceRow } from '@prisma/client';
import {
  type Workspace,
  type WorkspaceInputDTO,
  DEFAULT_WORKSPACE_ID,
  BadRequestError,
  NotFoundError,
} from '@syncle/core';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class WorkspaceStoreService implements OnModuleInit {
  private readonly logger = new Logger('Workspaces');

  constructor(private readonly prisma: PrismaService) {}

  // make sure the default workspace exists even on a DB that somehow missed the
  // migration seed (e.g. a hand-restored dump). cheap upsert, runs once on boot.
  async onModuleInit(): Promise<void> {
    try {
      await this.prisma.workspace.upsert({
        where: { id: DEFAULT_WORKSPACE_ID },
        update: {},
        create: { id: DEFAULT_WORKSPACE_ID, name: 'Default workspace' },
      });
    } catch (err) {
      this.logger.warn(`Could not ensure default workspace: ${(err as Error).message}`);
    }
  }

  private toWorkspace(row: WorkspaceRow): Workspace {
    return {
      id: row.id,
      name: row.name,
      color: row.color ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<Workspace[]> {
    const rows = await this.prisma.workspace.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toWorkspace(r));
  }

  async get(id: string): Promise<Workspace> {
    const row = await this.prisma.workspace.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(`Workspace "${id}" not found`);
    return this.toWorkspace(row);
  }

  async create(input: WorkspaceInputDTO): Promise<Workspace> {
    const row = await this.prisma.workspace.create({
      data: {
        id: randomUUID(),
        name: input.name,
        color: input.color ?? null,
      },
    });
    return this.toWorkspace(row);
  }

  async update(id: string, input: WorkspaceInputDTO): Promise<Workspace> {
    try {
      const row = await this.prisma.workspace.update({
        where: { id },
        data: { name: input.name, color: input.color ?? null },
      });
      return this.toWorkspace(row);
    } catch (err) {
      throw this.mapMissing(err, id);
    }
  }

  // deleting cascades to the workspace's connections and bridges (and their runs).
  // we keep the default workspace undeletable so there's always somewhere to land.
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_WORKSPACE_ID) {
      throw new BadRequestError('The default workspace cannot be deleted.');
    }
    try {
      await this.prisma.workspace.delete({ where: { id } });
    } catch (err) {
      throw this.mapMissing(err, id);
    }
  }

  /** a concurrent delete between read and write should 404, not 500 */
  private mapMissing(err: unknown, id: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return new NotFoundError(`Workspace "${id}" not found`);
    }
    return err;
  }
}
