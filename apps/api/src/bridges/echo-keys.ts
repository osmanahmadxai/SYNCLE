/**
 * everything the echo guard remembers about writes (loop prevention) lives
 * under this prefix, in Syncle's own Redis. kept apart from the service so that
 * what only needs to RECOGNISE such a key does not pull the service in
 */
export const ECHO_KEY_PREFIX = 'syncle:echo:';
