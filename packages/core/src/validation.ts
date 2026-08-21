/** shared Zod schemas for connection payloads (used on client and server) */
import { z } from 'zod';

export const engineSchema = z.enum([
  'postgres',
  'mysql',
  'sqlite',
  'mongodb',
  'redis',
  'mssql',
]);

/**
 * SSH tunnel in front of a network engine. secrets follow the same lifecycle
 * as the connection password: encrypted at rest, redacted in API responses
 */
export const sshConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().min(1, 'SSH host is required'),
  port: z.coerce.number().int().positive().default(22),
  username: z.string().min(1, 'SSH username is required'),
  authMethod: z.enum(['password', 'privateKey']),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
});

export const connectionInputSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(120),
    // which workspace this connection lives in; server defaults it when omitted
    workspaceId: z.string().optional(),
    engine: engineSchema,
    color: z.string().optional(),
    host: z.string().optional(),
    port: z.coerce.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    ssl: z.boolean().optional(),
    connectionString: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    ssh: sshConfigSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.ssh?.enabled) return;
    // sqlite is a local file — there is no network hop to tunnel
    if (val.engine === 'sqlite') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ssh'],
        message: 'SSH tunnels are not supported for SQLite connections',
      });
    }
    // the tunnel rewrites the discrete host/port; a full URI would bypass it
    if (val.connectionString) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ssh'],
        message:
          'SSH tunnels require discrete host/port fields, not a connection string',
      });
    }
  });

export type ConnectionInputDTO = z.infer<typeof connectionInputSchema>;
export type SshConfigDTO = z.infer<typeof sshConfigSchema>;

export const filterSchema = z.object({
  column: z.string(),
  operator: z.enum([
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'contains',
    'startsWith',
    'endsWith',
    'isNull',
    'notNull',
    'in',
  ]),
  value: z.unknown().optional(),
});

export const sortSchema = z.object({
  column: z.string(),
  direction: z.enum(['asc', 'desc']),
});

export const browseSchema = z.object({
  schema: z.string().optional(),
  table: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.array(sortSchema).optional(),
  filters: z.array(filterSchema).optional(),
});

export const querySchema = z.object({
  statement: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

export const insertRowSchema = z.object({
  schema: z.string().optional(),
  table: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
});

export const updateRowSchema = z.object({
  schema: z.string().optional(),
  table: z.string().min(1),
  identity: z.record(z.string(), z.unknown()),
  changes: z.record(z.string(), z.unknown()),
});

export const deleteRowSchema = z.object({
  schema: z.string().optional(),
  table: z.string().min(1),
  identity: z.record(z.string(), z.unknown()),
});

/* ----- DDL ----- */

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_$]*$/,
    'Use letters, digits and underscores; must not start with a digit',
  );

export const columnDefinitionSchema = z.object({
  name: identifierSchema,
  type: z.string().min(1).max(64),
  nullable: z.boolean().default(true),
  primaryKey: z.boolean().default(false),
  autoIncrement: z.boolean().default(false),
  unique: z.boolean().default(false),
  defaultValue: z.string().max(256).optional(),
});

export const createTableSchema = z.object({
  schema: z.string().optional(),
  table: identifierSchema,
  columns: z.array(columnDefinitionSchema).min(1),
});

export const databaseNameSchema = z.object({
  name: identifierSchema,
});

export const relationRefSchema = z.object({
  schema: z.string().optional(),
  table: z.string().min(1),
});

/* ----- backup & restore ----- */

export const backupFormatSchema = z.enum(['json', 'sql']);

export const backupSchema = z.object({
  format: backupFormatSchema.default('json'),
  tables: z.array(z.string()).optional(),
  schema: z.string().optional(),
});

export const restoreSchema = z.object({
  format: backupFormatSchema.default('json'),
  content: z.string().min(1),
});
