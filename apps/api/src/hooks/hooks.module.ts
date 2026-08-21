import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DeliveryService } from './delivery.service';
import { DatabaseSinkService } from './database-sink.service';
import { HookSinkService } from './hook-sink.service';
import { HookRunProcessor } from './hook-run.processor';
import { HookRunService } from './hook-run.service';
import { HookCdcService } from './hook-cdc.service';
import { HookLifecycleService } from './hook-lifecycle.service';
import { HookStoreService } from './hook-store.service';
import { HookWatchProcessor } from './hook-watch.processor';
import { HookWatchService } from './hook-watch.service';
import { HooksController } from './hooks.controller';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE, HOOK_WATCH_QUEUE } from './hooks.types';
import { CDC_PROVIDERS, type CdcProvider } from './cdc/cdc-provider';
import { PostgresCdcProvider } from './cdc/providers/postgres-cdc.provider';
import { MysqlCdcProvider } from './cdc/providers/mysql-cdc.provider';
import { MongodbCdcProvider } from './cdc/providers/mongodb-cdc.provider';
import { RedisCdcProvider } from './cdc/providers/redis-cdc.provider';
import { SqliteCdcProvider } from './cdc/providers/sqlite-cdc.provider';

@Module({
  imports: [
    ConnectionsModule, // AdapterPoolService
    BullModule.registerQueue({ name: HOOK_RUNS_QUEUE }),
    BullModule.registerQueue({ name: HOOK_WATCH_QUEUE }),
  ],
  controllers: [HooksController],
  providers: [
    HookStoreService,
    HookRunService,
    HookWatchService,
    HookCdcService,
    HookLifecycleService,
    DeliveryService,
    DatabaseSinkService,
    HookSinkService,
    RunRegistryService,
    HookRunProcessor,
    HookWatchProcessor,
    // CDC providers (one per engine) plus the aggregate the orchestrator injects
    PostgresCdcProvider,
    MysqlCdcProvider,
    MongodbCdcProvider,
    RedisCdcProvider,
    SqliteCdcProvider,
    {
      provide: CDC_PROVIDERS,
      inject: [
        PostgresCdcProvider,
        MysqlCdcProvider,
        MongodbCdcProvider,
        RedisCdcProvider,
        SqliteCdcProvider,
      ],
      useFactory: (...providers: CdcProvider[]): CdcProvider[] => providers,
    },
  ],
  // exported so WorkspacesModule can stop a workspace's live bridges on delete
  exports: [HookStoreService, HookWatchService, HookCdcService, HookLifecycleService],
})
export class HooksModule {}
