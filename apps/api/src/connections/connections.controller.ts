import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type ConnectionConfig,
  ConflictError,
  backupSchema,
  browseSchema,
  connectionInputSchema,
  createTableSchema,
  databaseNameSchema,
  deleteRowSchema,
  insertRowSchema,
  querySchema,
  relationRefSchema,
  restoreSchema,
  updateRowSchema,
  type ConnectionInputDTO,
} from '@syncle/core';
import type { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdapterPoolService } from './adapter-pool.service';
import { ConnectionStoreService } from './connection-store.service';

type BrowseDTO = z.infer<typeof browseSchema>;
type QueryDTO = z.infer<typeof querySchema>;
type InsertDTO = z.infer<typeof insertRowSchema>;
type UpdateDTO = z.infer<typeof updateRowSchema>;
type DeleteDTO = z.infer<typeof deleteRowSchema>;
type CreateTableDTO = z.infer<typeof createTableSchema>;
type DatabaseNameDTO = z.infer<typeof databaseNameSchema>;
type RelationRefDTO = z.infer<typeof relationRefSchema>;
type BackupDTO = z.infer<typeof backupSchema>;
type RestoreDTO = z.infer<typeof restoreSchema>;

@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly store: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly prisma: PrismaService,
  ) {}

  /* ----- CRUD ----- */

  @Get()
  list(
    @Query('workspaceId') workspaceId?: string,
  ): Promise<ConnectionConfig[]> {
    return this.store.list(workspaceId);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(connectionInputSchema)) dto: ConnectionInputDTO,
  ): Promise<ConnectionConfig> {
    return this.store.create(dto);
  }

  @Post('test')
  async testUnsaved(
    @Body(new ZodValidationPipe(connectionInputSchema)) dto: ConnectionInputDTO,
  ): Promise<{ success: true }> {
    const now = new Date().toISOString();
    const config: ConnectionConfig = {
      id: 'test',
      createdAt: now,
      updatedAt: now,
      ...dto,
      // a throwaway config just for a connectivity check; workspace is irrelevant
      workspaceId: dto.workspaceId ?? 'test',
    };
    await this.pool.test(config);
    return { success: true };
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<ConnectionConfig> {
    return this.store.get(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(connectionInputSchema)) dto: ConnectionInputDTO,
  ): Promise<ConnectionConfig> {
    const updated = await this.store.update(id, dto);
    await this.pool.evict(id);
    return updated;
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    await this.store.get(id); // 404s if missing
    // Bridge.connectionId has no FK, so enforce the reference here: deleting a
    // connection out from under its bridges would leave zombie listeners and
    // runs that can only fail. destinations embed connection ids in their
    // JSON, so a contains-check on the uuid covers that side too
    const [asSource, asDest] = await Promise.all([
      this.prisma.bridge.findMany({
        where: { connectionId: id },
        select: { id: true },
      }),
      this.prisma.bridge.findMany({
        where: { destinationJson: { contains: id } },
        select: { id: true },
      }),
    ]);
    const inUse = new Set([...asSource, ...asDest].map((h) => h.id)).size;
    if (inUse > 0) {
      throw new ConflictError(
        `This connection is used by ${inUse} bridge${inUse === 1 ? '' : 's'}. Delete or repoint ${inUse === 1 ? 'it' : 'them'} first.`,
      );
    }
    await this.pool.evict(id);
    await this.store.remove(id);
    return { id };
  }

  @Post(':id/test')
  async testSaved(@Param('id') id: string): Promise<{ success: true }> {
    await this.pool.test(await this.store.resolve(id));
    return { success: true };
  }

  /* ----- data operations ----- */

  @Get(':id/databases')
  databases(@Param('id') id: string): Promise<string[]> {
    return this.pool.withAdapter(id, undefined, (a) => a.listDatabases());
  }

  @Get(':id/schema')
  schema(@Param('id') id: string, @Query('database') database?: string) {
    const db = database || undefined;
    return this.pool.withAdapter(id, db, (a) => a.getSchema(db));
  }

  @Post(':id/browse')
  browse(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(browseSchema)) dto: BrowseDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.browse(dto),
    );
  }

  @Post(':id/query')
  query(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(querySchema)) dto: QueryDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.query(dto.statement, dto.params),
    );
  }

  @Post(':id/rows')
  insertRow(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(insertRowSchema)) dto: InsertDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.insertRow(dto),
    );
  }

  @Patch(':id/rows')
  updateRow(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRowSchema)) dto: UpdateDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.updateRow(dto),
    );
  }

  @Delete(':id/rows')
  deleteRow(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deleteRowSchema)) dto: DeleteDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.deleteRow(dto),
    );
  }

  /* ----- schema management (DDL) ----- */

  @Post(':id/ddl/database')
  async createDatabase(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(databaseNameSchema)) dto: DatabaseNameDTO,
  ): Promise<{ success: true }> {
    await this.pool.withAdapter(id, undefined, (a) =>
      a.createDatabase(dto.name),
    );
    return { success: true };
  }

  @Post(':id/ddl/drop-database')
  async dropDatabase(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(databaseNameSchema)) dto: DatabaseNameDTO,
  ): Promise<{ success: true }> {
    // close any pooled connection we hold to the target database, the engine
    // refuses to drop a database that still has active connections
    await this.pool.evict(id);
    await this.pool.withAdapter(id, undefined, (a) => a.dropDatabase(dto.name));
    return { success: true };
  }

  @Post(':id/ddl/table')
  async createTable(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createTableSchema)) dto: CreateTableDTO,
    @Query('database') database?: string,
  ): Promise<{ success: true }> {
    await this.pool.withAdapter(id, database || undefined, (a) =>
      a.createTable(dto),
    );
    return { success: true };
  }

  @Post(':id/ddl/drop-table')
  async dropTable(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(relationRefSchema)) dto: RelationRefDTO,
    @Query('database') database?: string,
  ): Promise<{ success: true }> {
    await this.pool.withAdapter(id, database || undefined, (a) =>
      a.dropTable(dto.table, dto.schema),
    );
    return { success: true };
  }

  @Post(':id/ddl/truncate-table')
  async truncateTable(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(relationRefSchema)) dto: RelationRefDTO,
    @Query('database') database?: string,
  ): Promise<{ success: true }> {
    await this.pool.withAdapter(id, database || undefined, (a) =>
      a.truncateTable(dto.table, dto.schema),
    );
    return { success: true };
  }

  /* ----- backup & restore ----- */

  @Post(':id/backup')
  async backup(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(backupSchema)) dto: BackupDTO,
    @Query('database') database?: string,
  ): Promise<{ filename: string; format: string; content: string }> {
    const content = await this.pool.withAdapter(id, database || undefined, (a) =>
      a.backup(dto),
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const base = (database || 'backup').replace(/[^\w.-]+/g, '_');
    return {
      filename: `${base}-${stamp}.${dto.format === 'sql' ? 'sql' : 'json'}`,
      format: dto.format,
      content,
    };
  }

  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(restoreSchema)) dto: RestoreDTO,
    @Query('database') database?: string,
  ) {
    return this.pool.withAdapter(id, database || undefined, (a) =>
      a.restore(dto.content, dto.format),
    );
  }
}
