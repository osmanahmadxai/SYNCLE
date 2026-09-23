/**
 * everything the HTTP application is configured with, in one place — so that a
 * test can boot exactly what production boots instead of an approximation of it
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppExceptionFilter } from './common/app-exception.filter';
import { TransformInterceptor } from './common/transform.interceptor';
import { runtimeConfig } from './common/runtime-config';
import { sameOriginOnly, securityHeaders } from './common/security';

export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: '50mb' });
  // the web app proxies /api to here, so X-Forwarded-Proto is what tells us
  // the scheme the *browser* used — which decides whether the session cookie
  // is marked Secure. without this every request looks like plain HTTP.
  // it also makes `req.ip` the left-most X-Forwarded-For entry, which a client
  // can set to anything: nothing that matters may be keyed on it alone (see
  // the login throttle in AuthService)
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: runtimeConfig.webOrigin, credentials: true });
  // after CORS (a preflight is answered there) and before every route: a
  // request that changes something has to come from the app itself
  app.use(
    sameOriginOnly(() => ([] as string[]).concat(runtimeConfig.webOrigin)),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
}
