/**
 * `GET /api/metrics`, for Prometheus and whatever speaks its text format.
 *
 * A scraper cannot log in, so this route is not behind the session — it is
 * behind a token of its own, and it does not exist until one is configured:
 * with `SYNCLE_METRICS_TOKEN` unset the answer is 404, the same as for any path
 * that is not there.
 */
import {
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { runtimeConfig } from '../common/runtime-config';
import { MetricsService } from './metrics.service';

export function tokenMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(presented ?? '')?.[1]?.trim() ?? '';
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual wants equal lengths; comparing `a` with itself keeps the
  // time spent the same whether or not the length gave it away
  return a.length === b.length
    ? timingSafeEqual(a, b)
    : (timingSafeEqual(a, a), false);
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const token = runtimeConfig.metricsToken;
    if (!token) throw new NotFoundException();
    if (!tokenMatches(authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException('A valid metrics token is required.');
    }
    // written directly: the text format, not the API's `{ data }` envelope
    const body = await this.metrics.render();
    res
      .status(200)
      .setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .end(body);
  }
}
