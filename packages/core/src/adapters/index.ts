/**
 * driver bootstrap. importing this module registers every built-in engine.
 * server code should import from here (not the individual adapter files) so the
 * registry is always populated
 */
import {
  listDrivers as _listDrivers,
  getDriver as _getDriver,
  createAdapter as _createAdapter,
  registerDriver,
  toDriverInfo,
  type DriverField,
} from './registry';
import {
  PostgresAdapter,
  POSTGRES_CAPABILITIES,
} from './sql/postgres-adapter';
import { MysqlAdapter, MYSQL_CAPABILITIES } from './sql/mysql-adapter';
import { SqliteAdapter, SQLITE_CAPABILITIES } from './sql/sqlite-adapter';
import {
  MongodbAdapter,
  MONGODB_CAPABILITIES,
} from './nosql/mongodb-adapter';
export {
  mergeSampledType,
  mongoTunnelOptions,
  normalizeMongoDocument,
  normalizeMongoValue,
} from './nosql/mongodb-adapter';
export { describeConnectionString, withDatabase, withHost } from './connection-string';
export {
  hostGateway,
  inContainer,
  isLoopbackHost,
  reachHostFromContainer,
  type HostReach,
} from './container-host';
export { redisGlobMatch, redisKeyPattern } from './nosql/redis-key-pattern';
export {
  describeTls,
  effectiveTls,
  mongoTlsOptions,
  mysqlTlsOptions,
  nodeTlsOptions,
  tlsServerName,
  verifyPeerIdentity,
  type NodeTlsOptions,
} from './tls-options';
import { RedisAdapter, REDIS_CAPABILITIES } from './nosql/redis-adapter';

const hostPortUserPass = (
  defaultPort: number,
  dbHint = 'Database name',
): DriverField[] => [
  { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
  {
    key: 'port',
    label: 'Port',
    type: 'number',
    required: true,
    placeholder: String(defaultPort),
  },
  { key: 'user', label: 'User', type: 'text', required: false },
  { key: 'password', label: 'Password', type: 'password', required: false },
  { key: 'database', label: 'Database', type: 'text', required: false, hint: dbHint },
];

/**
 * the adapters for these engines have always taken a connection string; only
 * MongoDB's form offered a place to type one. a hosted database usually hands
 * you exactly that and nothing else
 */
const connectionStringField = (placeholder: string, hint: string): DriverField => ({
  key: 'connectionString',
  label: 'Connection string (optional)',
  type: 'text',
  required: false,
  placeholder,
  hint,
});

const PG_TYPES = [
  'integer', 'bigint', 'serial', 'text', 'varchar(255)', 'boolean',
  'timestamptz', 'date', 'numeric', 'double precision', 'jsonb', 'uuid',
];
const MYSQL_TYPES = [
  'int', 'bigint', 'varchar(255)', 'text', 'boolean', 'datetime', 'date',
  'decimal(10,2)', 'double', 'json', 'tinyint',
];
const SQLITE_TYPES = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'];

let bootstrapped = false;

export function bootstrapDrivers(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  registerDriver({
    engine: 'postgres',
    label: 'PostgreSQL',
    description: 'Open-source relational database with rich SQL support.',
    defaultPort: 5432,
    capabilities: POSTGRES_CAPABILITIES,
    fields: [
      ...hostPortUserPass(5432),
      connectionStringField(
        'postgres://user:password@host:5432/database?sslmode=require',
        'What a hosted PostgreSQL (Neon, Supabase, RDS…) hands you. If set, it is used instead of the fields above. Not available together with an SSH tunnel.',
      ),
    ],
    dataTypes: PG_TYPES,
    create: (config) => new PostgresAdapter(config),
  });

  registerDriver({
    engine: 'mysql',
    label: 'MySQL / MariaDB',
    description: 'The world’s most popular open-source relational database.',
    defaultPort: 3306,
    capabilities: MYSQL_CAPABILITIES,
    fields: [
      ...hostPortUserPass(3306),
      connectionStringField(
        'mysql://user:password@host:3306/database',
        'If set, it is used instead of the fields above. Not available together with an SSH tunnel.',
      ),
    ],
    dataTypes: MYSQL_TYPES,
    create: (config) => new MysqlAdapter(config),
  });

  registerDriver({
    engine: 'sqlite',
    label: 'SQLite',
    description: 'Self-contained, file-based SQL database engine.',
    capabilities: SQLITE_CAPABILITIES,
    fields: [
      {
        key: 'database',
        label: 'Database file',
        type: 'text',
        required: true,
        placeholder: '/path/to/database.sqlite',
        hint: 'Absolute path to the .sqlite/.db file.',
      },
    ],
    dataTypes: SQLITE_TYPES,
    create: (config) => new SqliteAdapter(config),
  });

  registerDriver({
    engine: 'mongodb',
    label: 'MongoDB',
    description: 'Document-oriented NoSQL database.',
    defaultPort: 27017,
    capabilities: MONGODB_CAPABILITIES,
    fields: [
      ...hostPortUserPass(27017, 'Default database'),
      {
        key: 'connectionString',
        label: 'Connection URI (optional)',
        type: 'text',
        required: false,
        placeholder: 'mongodb+srv://…',
        hint: 'If set, overrides the fields above (use for Atlas).',
      },
    ],
    dataTypes: [],
    create: (config) => new MongodbAdapter(config),
  });

  registerDriver({
    engine: 'redis',
    label: 'Redis',
    description: 'In-memory key-value data store.',
    defaultPort: 6379,
    capabilities: REDIS_CAPABILITIES,
    fields: [
      ...hostPortUserPass(6379, 'Logical DB index (0–15)'),
      connectionStringField(
        'rediss://default:password@host:6379/0',
        'What a hosted Redis (Upstash, Redis Cloud…) hands you; rediss:// asks for TLS by itself. If set, it is used instead of the fields above. Not available together with an SSH tunnel.',
      ),
    ],
    dataTypes: [],
    create: (config) => new RedisAdapter(config),
  });
}

// bootstrap on first import
bootstrapDrivers();

export const listDrivers = _listDrivers;
export const getDriver = _getDriver;
export const createAdapter = _createAdapter;
export { toDriverInfo };
export type { DriverInfo } from './registry';
