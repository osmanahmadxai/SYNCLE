import { Global, Module } from '@nestjs/common';
import { AlertChannelStore } from './alert-channel.store';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

// @Global: anything that stops a bridge can say so without importing this.
// it depends on nothing but the (global) common module, so it cannot be part
// of an import cycle with the modules that call it
@Global()
@Module({
  controllers: [AlertsController],
  providers: [AlertChannelStore, AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
