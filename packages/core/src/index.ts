/**
 * web-safe entry point: types, error classes, and validation schemas only.
 * importing this never pulls in a native database driver, so it's safe for the
 * browser bundle. server code that needs to open connections imports from
 * `@syncle/core/adapters` instead.
 */
export * from './adapters/types';
export * from './errors';
export * from './sql';
export * from './validation';
export * from './hooks';
export * from './workspace';
export * from './auth';

// type-only re-exports of the driver metadata (no driver implementations are
// pulled in, so this stays safe for the browser bundle)
export type {
  DriverInfo,
  DriverField,
  DriverDefinition,
} from './adapters/registry';
