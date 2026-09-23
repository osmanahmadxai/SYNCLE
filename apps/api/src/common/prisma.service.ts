import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { writeMiddleware, type WriteListener } from '../events/write-events';

/**
 * Prisma client lifecycle, managed by Nest. backs the app's own
 * metadata store (saved connections) only.
 *
 * every write goes past {@link onWrite}'s listeners once it is done — that is
 * how the page is told something changed (see EventsService) without every
 * service having to say so
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('Prisma');
  private readonly writeListeners = new Set<WriteListener>();

  constructor() {
    super();
    this.$use(writeMiddleware(this.writeListeners));
  }

  /** hear of every write to the store, after it happened; returns what stops listening */
  onWrite(listener: WriteListener): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to metadata store');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
