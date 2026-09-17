import { SetMetadata } from '@nestjs/common';

/**
 * a route that concerns credentials themselves — API keys, the password, the
 * session — and therefore answers to a PERSON who signed in, never to an API
 * key: a leaked key must not be able to mint more keys, or lock the operator out
 */
export const SESSION_ONLY = 'auth:session-only';
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);
