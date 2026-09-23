/** shared Zod schemas for connection payloads (used on client and server) */
import { z } from 'zod';

// mirrors the DatabaseEngine union: the engines that HAVE an adapter. `mssql`
// used to be listed as a forward declaration, on the understanding that the API
// would refuse it until a driver existed — it never did, so such a connection
// could be saved and then answered 501 to everything. an engine goes here when
// its adapter does (a test holds the two lists together), and the API checks the
// driver registry as well before it persists anything.
export const engineSchema = z.enum([
  'postgres',
  'mysql',
  'sqlite',
  'mongodb',
  'redis',
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
  hostKey: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(v), {
      message: 'Expected an OpenSSH fingerprint, e.g. SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
    })
    .optional(),
});

const pem = (what: string) =>
  z
    .string()
    .max(64_000)
    .refine((v) => v.trim() === '' || /-----BEGIN [A-Z0-9 ]+-----/.test(v), {
      message: `${what} must be PEM text (it starts with "-----BEGIN …-----")`,
    });

export const tlsConfigSchema = z
  .object({
    mode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']),
    ca: pem('The CA certificate').optional(),
    cert: pem('The client certificate').optional(),
    // may also be the redaction sentinel on an update ("keep what is stored")
    key: z.string().max(64_000).optional(),
    servername: z.string().max(255).optional(),
  })
  .superRefine((val, ctx) => {
    const has = (v?: string): boolean => !!v && v.trim() !== '';
    if (has(val.cert) !== has(val.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [has(val.cert) ? 'key' : 'cert'],
        message: 'A client certificate and its private key are given together, or not at all',
      });
    }
  });

export const connectionInputSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(120),
    // which workspace this connection lives in; server defaults it when omitted
    workspaceId: z.string().optional(),
    engine: engineSchema,
    color: z.string().optional(),
    /**
     * nothing is written through this connection: no row, no table, no restore,
     * no statement in the editor that is not recognisably a read — and it cannot
     * be a bridge's destination. a guard against accidents, not a security
     * boundary: for that, connect with a database role that cannot write
     */
    readOnly: z.boolean().optional(),
    /** what this database is, so that production looks like production everywhere it is shown */
    environment: z.enum(['production', 'staging', 'development']).optional(),
    host: z.string().optional(),
    port: z.coerce.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    ssl: z.boolean().optional(),
    tls: tlsConfigSchema.optional(),
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
