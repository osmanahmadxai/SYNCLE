import { Module } from '@nestjs/common';
import { AdapterPoolService } from './adapter-pool.service';
import { ConnectionStoreService } from './connection-store.service';
import { ConnectionsController } from './connections.controller';
import { SshTunnelService } from './ssh-tunnel.service';

// PrismaService + CryptoService come from the global CommonModule
@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionStoreService, AdapterPoolService, SshTunnelService],
  // SshTunnelService: a change stream opens its own connections, so it needs
  // its own tunnel — one that lives as long as the stream, not as long as a
  // pooled adapter
  exports: [ConnectionStoreService, AdapterPoolService, SshTunnelService],
})
export class ConnectionsModule {}
