import { Audited } from '../audit/audited.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  type Workspace,
  type WorkspaceInputDTO,
  workspaceInputSchema,
} from '@syncle/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BridgeStoreService } from '../bridges/bridge-store.service';
import { BridgeLifecycleService } from '../bridges/bridge-lifecycle.service';
import { WorkspaceStoreService } from './workspace-store.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly store: WorkspaceStoreService,
    private readonly bridges: BridgeStoreService,
    private readonly lifecycle: BridgeLifecycleService,
  ) {}

  @Get()
  list(): Promise<Workspace[]> {
    return this.store.list();
  }

  @Roles('admin')
  @Post()
  @Audited('workspace.create')
  create(
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Workspace> {
    return this.store.get(id);
  }

  @Roles('admin')
  @Put(':id')
  @Audited('workspace.update')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.update(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  @Audited('workspace.delete')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    // full teardown of every bridge before the cascade delete: CDC slots get
    // dropped, watch schedulers stop, and in-flight replay runs are canceled
    // (the same sequence a single-bridge delete performs)
    const bridges = await this.bridges.list(id).catch(() => []);
    for (const bridge of bridges) {
      await this.lifecycle.teardown(bridge.id);
    }
    await this.store.remove(id);
    return { id };
  }
}
