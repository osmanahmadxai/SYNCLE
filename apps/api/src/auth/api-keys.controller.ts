import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  apiKeyInputSchema,
  type ApiKeyCreated,
  type ApiKeyInfo,
  type ApiKeyInputDTO,
} from '@syncle/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiKeyService } from './api-key.service';
import { SessionOnly } from './session-only.decorator';

/** managing keys is for a person who signed in: a key cannot mint or revoke keys */
@SessionOnly()
@Controller('auth/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Get()
  list(): Promise<ApiKeyInfo[]> {
    return this.keys.list();
  }

  /** the answer carries the key itself — this once, and never again */
  @Post()
  create(
    @Body(new ZodValidationPipe(apiKeyInputSchema)) dto: ApiKeyInputDTO,
  ): Promise<ApiKeyCreated> {
    return this.keys.create(dto);
  }

  @Delete(':id')
  revoke(@Param('id') id: string): Promise<ApiKeyInfo> {
    return this.keys.revoke(id);
  }
}
