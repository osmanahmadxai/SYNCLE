import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { redisConnectionOptions } from './common/runtime-config';
import { ConnectionsModule } from './connections/connections.module';
import { DriversModule } from './drivers/drivers.module';
import { BridgesModule } from './bridges/bridges.module';
import { SettingsModule } from './settings/settings.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    CommonModule,
    // SettingsModule + AuthModule are global; AuthModule registers the
    // app-wide guard, so every route below is protected unless marked @Public()
    SettingsModule,
    AuthModule,
    BullModule.forRoot({ connection: redisConnectionOptions() }),
    ConnectionsModule,
    DriversModule,
    BridgesModule,
    WorkspacesModule,
  ],
})
export class AppModule {}
