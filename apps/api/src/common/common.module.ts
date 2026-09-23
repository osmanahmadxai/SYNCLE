import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { InstanceService } from './instance.service';
import { KeyRotationService } from './key-rotation.service';
import { PrismaService } from './prisma.service';
import { VersionController } from './version.controller';

/**
 * shared singletons (Prisma client + credential crypto). marked `@Global` so any
 * feature module can inject them without re-listing them as providers, which
 * would otherwise create a second `CryptoService` that reloads the master key
 */
@Global()
@Module({
  controllers: [VersionController],
  providers: [
    PrismaService,
    CryptoService,
    KeyRotationService,
    InstanceService,
  ],
  exports: [PrismaService, CryptoService, KeyRotationService, InstanceService],
})
export class CommonModule {}
