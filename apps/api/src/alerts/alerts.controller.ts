import { Audited } from '../audit/audited.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  alertChannelInputSchema,
  type AlertChannel,
  type AlertChannelInput,
  type AlertTestResult,
} from '@syncle/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AlertChannelStore } from './alert-channel.store';
import { AlertsService } from './alerts.service';

/** what a test answered, in short, for the audit entry */
function summary(result: unknown): Record<string, unknown> {
  const r = (result ?? {}) as Record<string, unknown>;
  return { ok: r.ok, error: typeof r.error === 'string' ? r.error.slice(0, 200) : undefined };
}

@Controller('alerts/channels')
export class AlertsController {
  constructor(
    private readonly store: AlertChannelStore,
    private readonly alerts: AlertsService,
  ) {}

  @Get()
  list(): Promise<AlertChannel[]> {
    return this.store.list();
  }

  @Roles('admin')
  @Post()
  @Audited('alert_channel.create', ({ result }) => ({ details: { kind: (result as { kind?: string })?.kind } }))
  create(
    @Body(new ZodValidationPipe(alertChannelInputSchema))
    dto: AlertChannelInput,
  ): Promise<AlertChannel> {
    return this.store.create(dto);
  }

  @Roles('admin')
  @Put(':id')
  @Audited('alert_channel.update')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertChannelInputSchema))
    dto: AlertChannelInput,
  ): Promise<AlertChannel> {
    return this.store.update(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  @Audited('alert_channel.delete')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.store.remove(id);
  }

  /** send a test message through the channel as it is stored */
  @Roles('admin')
  @Post(':id/test')
  @Audited('alert_channel.test', ({ result }) => ({ details: summary(result) }))
  @HttpCode(200)
  test(@Param('id') id: string): Promise<AlertTestResult> {
    return this.alerts.test(id);
  }
}
