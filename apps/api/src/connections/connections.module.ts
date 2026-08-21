import { Module } from '@nestjs/common';
import { AdapterPoolService } from './adapter-pool.service';
import { ConnectionStoreService } from './connection-store.service';
import { ConnectionsController } from './connections.controller';
import { SshTunnelService } from './ssh-tunnel.service';

// PrismaService + CryptoService come from the global CommonModule
@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionStoreService, AdapterPoolService, SshTunnelService],
  exports: [ConnectionStoreService, AdapterPoolService],
})
export class ConnectionsModule {}
