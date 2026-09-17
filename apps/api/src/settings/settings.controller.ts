import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  appSettingsSchema,
  type AppSettings,
  type AppSettingsDTO,
} from '@syncle/core';
import { SessionOnly } from '../auth/session-only.decorator';
import {
  KeyRotationService,
  type KeyRotationReport,
} from '../common/key-rotation.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SettingsStoreService } from './settings-store.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly store: SettingsStoreService,
    private readonly keys: KeyRotationService,
  ) {}

  @Get()
  get(): Promise<AppSettings> {
    return this.store.resolved();
  }

  @Put()
  update(
    @Body(new ZodValidationPipe(appSettingsSchema)) dto: AppSettingsDTO,
  ): Promise<AppSettings> {
    return this.store.update(dto);
  }

  /**
   * changing the master key: how many previous keys this instance still accepts,
   * and what the last pass over the stored secrets found. see KeyRotationService
   */
  @Get('encryption')
  encryption(): KeyRotationReport {
    return this.keys.status();
  }

  /** look again now (it also runs at every start). not something an API key may do */
  @SessionOnly()
  @Post('encryption/rotate')
  @HttpCode(200)
  rotate(): Promise<KeyRotationReport> {
    return this.keys.rotate();
  }
}
