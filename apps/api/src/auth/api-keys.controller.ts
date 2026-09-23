import { Audited } from '../audit/audited.decorator';
import { Roles } from './roles.decorator';
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
@Roles('admin')
@Controller('auth/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Get()
  list(): Promise<ApiKeyInfo[]> {
    return this.keys.list();
  }

  /** the answer carries the key itself — this once, and never again */
  @Post()
  @Audited('api_key.create', ({ result }) => {
    // (never the key itself)
    const made = result as { id: string; name: string; scope: string; expiresAt: string | null };
    return { target: { type: 'api_key', id: made.id, name: made.name }, details: { scope: made.scope, expiresAt: made.expiresAt } };
  })
  create(
    @Body(new ZodValidationPipe(apiKeyInputSchema)) dto: ApiKeyInputDTO,
  ): Promise<ApiKeyCreated> {
    return this.keys.create(dto);
  }

  @Delete(':id')
  @Audited('api_key.revoke', ({ result }) => {
    const key = result as { id: string; name: string };
    return { target: { type: 'api_key', id: key.id, name: key.name } };
  })
  revoke(@Param('id') id: string): Promise<ApiKeyInfo> {
    return this.keys.revoke(id);
  }
}
