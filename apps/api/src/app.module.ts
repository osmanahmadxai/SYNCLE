import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AlertsModule } from './alerts/alerts.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { redisConnectionOptions } from './common/runtime-config';
import { ConnectionsModule } from './connections/connections.module';
import { DriversModule } from './drivers/drivers.module';
import { EventsModule } from './events/events.module';
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
    // global too: whatever changes something records that it did
    AuditModule,
    // global too: whatever stops a bridge can raise an alert about it
    AlertsModule,
    ObservabilityModule,
    BullModule.forRoot({ connection: redisConnectionOptions() }),
    ConnectionsModule,
    DriversModule,
    EventsModule,
    BridgesModule,
    WorkspacesModule,
  ],
})
export class AppModule {}
