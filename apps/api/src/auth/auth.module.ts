import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';
import { ApiKeysController } from './api-keys.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

// PrismaService + CryptoService come from the global CommonModule, and
// SettingsStoreService from the global SettingsModule. Registering AuthGuard as
// an APP_GUARD makes it protect EVERY route in the app (opt out with @Public()).
@Module({
  controllers: [AuthController, ApiKeysController],
  providers: [AuthService, ApiKeyService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
