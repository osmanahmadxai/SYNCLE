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
import type { AppUser } from '@prisma/client';
import {
  UnauthorizedError,
  userInputSchema,
  userUpdateSchema,
  type UserInfo,
  type UserInputDTO,
  type UserUpdateDTO,
} from '@syncle/core';
import { Audited } from '../audit/audited.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser } from './current-user.decorator';
import { Roles } from './roles.decorator';
import { SessionOnly } from './session-only.decorator';
import { UsersService } from './users.service';

/** the accounts: an admin's to manage, signed in (never with an API key) */
@SessionOnly()
@Roles('admin')
@Controller('auth/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<UserInfo[]> {
    return this.users.list();
  }

  @Post()
  @Audited('user.create', ({ result }) => {
    const user = result as UserInfo;
    return {
      target: { type: 'user', id: user.id, name: user.username },
      details: { role: user.role },
    };
  })
  create(
    @Body(new ZodValidationPipe(userInputSchema)) dto: UserInputDTO,
  ): Promise<UserInfo> {
    return this.users.create(dto);
  }

  @Put(':id')
  @Audited('user.update', ({ params, body, result }) => {
    const patch = body as UserUpdateDTO;
    return {
      target: {
        type: 'user',
        id: params.id,
        name: (result as UserInfo).username,
      },
      details: {
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        ...(patch.newPassword !== undefined ? { passwordSet: true } : {}),
      },
    };
  })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(userUpdateSchema)) dto: UserUpdateDTO,
    @CurrentUser() by: AppUser | undefined,
  ): Promise<UserInfo> {
    if (!by) throw new UnauthorizedError();
    return this.users.update(id, dto, by);
  }

  @Delete(':id')
  @Audited('user.delete', ({ result }) => {
    const gone = result as { id: string; username: string };
    return { target: { type: 'user', id: gone.id, name: gone.username } };
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() by: AppUser | undefined,
  ): Promise<{ id: string; username: string }> {
    if (!by) throw new UnauthorizedError();
    return this.users.remove(id, by);
  }

  /** every session of the account ends now; it can sign in again */
  @Post(':id/sessions/end')
  @HttpCode(200)
  @Audited('user.sessions_ended', ({ params, result }) => ({
    target: {
      type: 'user',
      id: params.id,
      name: (result as UserInfo).username,
    },
  }))
  endSessions(@Param('id') id: string): Promise<UserInfo> {
    return this.users.endSessions(id);
  }
}
