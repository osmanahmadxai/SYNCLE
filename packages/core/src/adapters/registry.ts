/**
 * driver registry, the single extension point for new databases.
 *
 * to add an engine:
 *   1. implement `DatabaseAdapter` in `core/adapters/<engine>.ts`
 *   2. add a `DriverDefinition` entry below
 * the connection form, sidebar, and routing all derive from this list, so no
 * other file needs to change
 */
import type {
  AdapterCapabilities,
  ConnectionConfig,
  DatabaseAdapter,
  DatabaseEngine,
} from './types';
import { UnsupportedError } from '../errors';

/** a single connection-form field descriptor (drives the dynamic UI form) */
export interface DriverField {
  key: 'host' | 'port' | 'user' | 'password' | 'database' | 'connectionString';
  label: string;
  type: 'text' | 'password' | 'number';
  required: boolean;
  placeholder?: string;
  /** help text shown under the field */
  hint?: string;
}

export interface DriverDefinition {
  engine: DatabaseEngine;
  label: string;
  /** one-line description for the engine picker */
  description: string;
  defaultPort?: number;
  capabilities: AdapterCapabilities;
  /** fields shown in the connection editor for this engine */
  fields: DriverField[];
  /** common column types offered in the create-table form (free text allowed) */
  dataTypes: string[];
  /** lazily constructs an adapter for the given config */
  create: (config: ConnectionConfig) => DatabaseAdapter;
}

const registry = new Map<DatabaseEngine, DriverDefinition>();

export function registerDriver(def: DriverDefinition): void {
  registry.set(def.engine, def);
}

export function getDriver(
  engine: DatabaseEngine,
): DriverDefinition | undefined {
  return registry.get(engine);
}

export function listDrivers(): DriverDefinition[] {
  return [...registry.values()];
}

/** construct an adapter instance for a saved connection */
export function createAdapter(config: ConnectionConfig): DatabaseAdapter {
  const def = registry.get(config.engine);
  if (!def) {
    // typed so routes answer 501 instead of a generic 500 (a connection saved
    // by a build that had a driver this one does not)
    throw new UnsupportedError(
      `No driver is registered for engine "${config.engine}"`,
    );
  }
  return def.create(config);
}

/** public, serializable view of a driver for the client (no `create`) */
export interface DriverInfo {
  engine: DatabaseEngine;
  label: string;
  description: string;
  defaultPort?: number;
  capabilities: AdapterCapabilities;
  fields: DriverField[];
  dataTypes: string[];
}

export function toDriverInfo(def: DriverDefinition): DriverInfo {
  const { create: _create, ...info } = def;
  return info;
}
