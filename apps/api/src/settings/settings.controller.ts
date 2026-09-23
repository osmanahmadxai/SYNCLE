import { Audited } from '../audit/audited.decorator';
import { Roles } from '../auth/roles.decorator';
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  appSettingsSchema,
  type AppSettings,
  type AppSettingsDTO,
} from '@syncle/core';
import { SessionOnly } from '../auth/session-only.decorator';
import { InstanceService, type InstanceInfo } from '../common/instance.service';
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
    private readonly instance: InstanceService,
  ) {}

  /**
   * the API processes that are alive on this database and this Redis, and which
   * of them leads (it runs the live change streams and the periodic sweeps).
   * one process is the usual answer; see InstanceService for what two mean
   */
  @Get('instances')
  instances(): Promise<InstanceInfo[]> {
    return this.instance.instances();
  }

  @Get()
  get(): Promise<AppSettings> {
    return this.store.resolved();
  }

  @Roles('admin')
  @Put()
  @Audited('settings.update', ({ body }) => ({ target: null, details: body as Record<string, unknown> }))
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
  @Roles('admin')
  @Post('encryption/rotate')
  @Audited('encryption.rotate', ({ result }) => ({ target: null, details: result as Record<string, unknown> }))
  @HttpCode(200)
  rotate(): Promise<KeyRotationReport> {
    return this.keys.rotate();
  }
}
