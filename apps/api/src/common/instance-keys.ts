/**
 * what `InstanceService` keeps in Syncle's own Redis (who leads, who is alive,
 * who holds which lock). kept apart from the service so that what only needs
 * to RECOGNISE such a key — a bridge that reads that Redis — does not pull the
 * service in
 */
export const LEADER_KEY = 'syncle:leader';
export const INSTANCE_PREFIX = 'syncle:instance:';
export const LOCK_PREFIX = 'syncle:lock:';
export const BUS_CHANNEL = 'syncle:bus';

export const INSTANCE_KEY_PREFIXES = [LEADER_KEY, INSTANCE_PREFIX, LOCK_PREFIX];
