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

  @Post()
  create(
    @Body(new ZodValidationPipe(alertChannelInputSchema))
    dto: AlertChannelInput,
  ): Promise<AlertChannel> {
    return this.store.create(dto);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertChannelInputSchema))
    dto: AlertChannelInput,
  ): Promise<AlertChannel> {
    return this.store.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.store.remove(id);
  }

  /** send a test message through the channel as it is stored */
  @Post(':id/test')
  @HttpCode(200)
  test(@Param('id') id: string): Promise<AlertTestResult> {
    return this.alerts.test(id);
  }
}
