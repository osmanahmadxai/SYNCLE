import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * wraps every successful response in a `{ data }` envelope. a stream of
 * server-sent events (`@Sse()`) is not a response but many messages, each
 * already in its own shape: those go as they are
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, { data: T } | T>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<{ data: T } | T> {
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler()))
      return next.handle();
    return next.handle().pipe(map((data) => ({ data })));
  }
}
