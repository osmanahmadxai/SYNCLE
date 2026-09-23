/**
 * `GET /api/events`: a stream of server-sent events, one {@link LiveEvent}
 * per message (`data:` is its JSON). opened by the browser with an
 * EventSource — the session cookie goes with it — or by anything else with an
 * API key, the way any GET is. the stream is ended by the server every
 * {@link STREAM_MAX_AGE_MS}; a client that wants to keep listening opens it
 * again (an EventSource does that by itself).
 */
import { Controller, type MessageEvent, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  stream(): Observable<MessageEvent> {
    return this.events.stream();
  }
}
