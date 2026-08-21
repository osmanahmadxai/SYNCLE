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
import { HookStoreService } from '../hooks/hook-store.service';
import { HookLifecycleService } from '../hooks/hook-lifecycle.service';
import { WorkspaceStoreService } from './workspace-store.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly store: WorkspaceStoreService,
    private readonly hooks: HookStoreService,
    private readonly lifecycle: HookLifecycleService,
  ) {}

  @Get()
  list(): Promise<Workspace[]> {
    return this.store.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Workspace> {
    return this.store.get(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    // full teardown of every hook before the cascade delete: CDC slots get
    // dropped, watch schedulers stop, and in-flight replay runs are canceled
    // (the same sequence a single-hook delete performs)
    const hooks = await this.hooks.list(id).catch(() => []);
    for (const hook of hooks) {
      await this.lifecycle.teardown(hook.id);
    }
    await this.store.remove(id);
    return { id };
  }
}
