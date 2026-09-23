import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  setupSchema,
  type AuthStatus,
  type AuthUser,
  type ChangePasswordDTO,
  type LoginDTO,
  type PasswordResetDTO,
  type PasswordResetRequestDTO,
  type SetupDTO,
  UnauthorizedError,
} from '@syncle/core';
import type { AppUser } from '@prisma/client';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';
import { Audited } from '../audit/audited.decorator';
import { SessionOnly } from './session-only.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** which screen the web app should show: setup, login, or the app */
  @Public()
  @Get('status')
  async status(@Req() req: Request): Promise<AuthStatus> {
    const needsSetup = !(await this.auth.hasAccount());
    const user = await this.auth.userFromRequest(req);
    return {
      needsSetup,
      authenticated: !!user,
      user: user ? this.auth.toAuthUser(user) : null,
    };
  }

  /** create the single admin account on first run, and sign them in */
  @Public()
  @Post('setup')
  async setup(
    @Body(new ZodValidationPipe(setupSchema)) dto: SetupDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const user = await this.auth.setup(
      dto.username,
      dto.password,
      dto.setupToken,
      req.ip ?? '',
    );
    await this.auth.issueSession(res, user);
    return this.auth.toAuthUser(user);
  }

  @Public()
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const user = await this.auth.login(dto.username, dto.password, req.ip ?? '');
    await this.auth.issueSession(res, user);
    return this.auth.toAuthUser(user);
  }

  /**
   * "I cannot sign in." a reset code is printed on the server's console (and
   * put in its data directory): being able to read it there is the proof of
   * being the operator. answers the same whatever happened
   */
  @Public()
  @Post('reset/request')
  @HttpCode(202)
  async requestReset(
    @Body(new ZodValidationPipe(passwordResetRequestSchema)) dto: PasswordResetRequestDTO,
    @Req() req: Request,
  ): Promise<{ requested: true }> {
    await this.auth.requestPasswordReset(dto.username || undefined, req.ip ?? '');
    return { requested: true };
  }

  /** a new password, with the code from the server's console; signs in, and ends every other session */
  @Public()
  @Post('reset')
  async reset(
    @Body(new ZodValidationPipe(passwordResetSchema)) dto: PasswordResetDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const user = await this.auth.resetPassword(dto.resetCode, dto.newPassword, req.ip ?? '');
    await this.auth.issueSession(res, user);
    return this.auth.toAuthUser(user);
  }

  @SessionOnly()
  @Post('logout')
  @Audited('auth.logout', () => ({ target: null }))
  logout(@Res({ passthrough: true }) res: Response): { success: true } {
    this.auth.clearSession(res);
    return { success: true };
  }

  @SessionOnly()
  @Get('me')
  me(@CurrentUser() user: AppUser | undefined): AuthUser {
    if (!user) throw new UnauthorizedError();
    return this.auth.toAuthUser(user);
  }

  @SessionOnly()
  @Post('change-password')
  @Audited('auth.password_changed', () => ({ target: null }))
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDTO,
    @CurrentUser() user: AppUser | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    if (!user) throw new UnauthorizedError();
    const updated = await this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    // the version bump just invalidated this session's cookie too — re-issue it
    await this.auth.issueSession(res, updated);
    return this.auth.toAuthUser(updated);
  }
}
