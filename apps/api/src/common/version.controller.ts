/**
 * which version is running. behind the login like everything else: the public
 * health probe deliberately says nothing beyond "up", and a version number is
 * exactly what someone scanning for a known flaw wants to read without asking.
 */
import { Controller, Get } from '@nestjs/common';
import { resolveVersion, type VersionInfo } from './version';

@Controller('version')
export class VersionController {
  private readonly info = resolveVersion();

  @Get()
  version(): VersionInfo {
    return this.info;
  }
}
