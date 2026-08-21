import { Module } from '@nestjs/common';
import { BridgesModule } from '../bridges/bridges.module';
import { WorkspaceStoreService } from './workspace-store.service';
import { WorkspacesController } from './workspaces.controller';

// PrismaService comes from the global CommonModule. BridgesModule is imported so
// we can stop a workspace's live bridges before deleting it.
@Module({
  imports: [BridgesModule],
  controllers: [WorkspacesController],
  providers: [WorkspaceStoreService],
  exports: [WorkspaceStoreService],
})
export class WorkspacesModule {}
