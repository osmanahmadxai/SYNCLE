import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { redisConnectionOptions } from './common/runtime-config';
import { ConnectionsModule } from './connections/connections.module';
import { DriversModule } from './drivers/drivers.module';
import { ObservabilityModule } from './observability/observability.module';
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
    // global too: whatever stops a bridge can raise an alert about it
    AlertsModule,
    ObservabilityModule,
    BullModule.forRoot({ connection: redisConnectionOptions() }),
    ConnectionsModule,
    DriversModule,
    BridgesModule,
    WorkspacesModule,
  ],
})
export class AppModule {}
