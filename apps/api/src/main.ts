import 'reflect-metadata';
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { TransformInterceptor } from './common/transform.interceptor';
import { runtimeConfig } from './common/runtime-config';

const logger = new Logger('Bootstrap');

// last-resort handlers: a stray rejection (e.g. a driver emitting an error on
// an idle pooled connection) must never take the server down silently
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  logger.error(`Unhandled promise rejection: ${msg}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
  // state may be corrupt after an uncaught throw; exit and let the supervisor restart
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // quiet the verbose route-mapping/bootstrap logs so the combined
    // `pnpm dev` output stays readable. errors and warnings still show
    logger: ['error', 'warn'],
    // registered manually below so the JSON limit is explicit: backup/restore
    // payloads carry whole dumps and would 413 on the 100kb express default
    bodyParser: false,
  });

  app.useBodyParser('json', { limit: '50mb' });
  // the web app proxies /api to here, so X-Forwarded-Proto is what tells us
  // the scheme the *browser* used — which decides whether the session cookie
  // is marked Secure. without this every request looks like plain HTTP
  app.set('trust proxy', true);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: runtimeConfig.webOrigin, credentials: true });
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableShutdownHooks();

  await app.listen(runtimeConfig.port);

  // this is the last thing to print after a `pnpm dev/start`, so show both
  // URLs here, the web one first since that's the one you actually open. the
  // plain console.log so it always shows regardless of the nest log level
  const webPort = process.env.WEB_PORT ?? '3002';
  console.log(
    `\n  Syncle · ready\n\n` +
      `    Web  http://localhost:${webPort}   ← open this\n` +
      `    API  http://localhost:${runtimeConfig.port}/api\n`,
  );
}

bootstrap().catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${runtimeConfig.port} is already in use. Stop the other process or set PORT.`,
    );
  } else {
    logger.error(`Failed to start: ${err.stack ?? err.message}`);
  }
  process.exit(1);
});
