/**
 * typed client for the Syncle NestJS API. unwraps the `{ data }` envelope,
 * throws a structured {@link ApiError} on `{ error }` responses
 */
import type {
  AlertChannel,
  AlertChannelInput,
  AlertTestResult,
  ApiKeyCreated,
  ApiKeyInfo,
  ApiKeyInputDTO,
  AppSettings,
  AppSettingsDTO,
  BridgeExportDocument,
  BridgeImportDTO,
  BridgeImportResult,
  AuthStatus,
  AuthUser,
  BrowseParams,
  BrowseResult,
  ChangePasswordDTO,
  ConnectionConfig,
  ConnectionInputDTO,
  CreateTableSpec,
  DatabaseSchema,
  DeleteRowParams,
  CdcReadiness,
  CdcReadinessDTO,
  DeadLetterPage,
  DeadLetterRetryResult,
  DeadLetterStatus,
  DriverInfo,
  Bridge,
  BridgeDelivery,
  BridgeInputDTO,
  BridgePreview,
  BridgePreviewDTO,
  BridgeJob,
  InsertRowParams,
  LoginDTO,
  QueryResult,
  SetupDTO,
  UpdateRowParams,
  Workspace,
  WorkspaceInputDTO,
  BridgeSourceHold,
  BridgeSchemaDrift,
} from '@syncle/core';

/**
 * Relative by default: calls go to the page's own origin and are proxied to
 * the API by src/app/api/[...path]/route.ts. Keeping the API's address out of
 * the bundle is what lets one published image run anywhere — NEXT_PUBLIC_*
 * values are inlined at build time. Set NEXT_PUBLIC_API_URL to an absolute URL
 * to bypass the proxy and call the API directly (then CORS applies).
 */
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      // send/receive the httpOnly session cookie on every call. same-origin
      // through the proxy, but kept explicit so an absolute
      // NEXT_PUBLIC_API_URL (direct, cross-origin) still authenticates
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach the Syncle API at ${BASE_URL}. Is it running?`,
      'NETWORK',
      0,
      (err as Error).message,
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(
      error.message ?? `Request failed (${res.status})`,
      error.code ?? 'UNKNOWN',
      res.status,
      error.details,
    );
  }
  // a 2xx with an empty/non-JSON body parses to null — don't throw on it
  return body?.data as T;
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

export const api = {
  listDrivers: () => request<DriverInfo[]>('/drivers'),

  /* ----- auth ----- */
  listAuthStatus: () => request<AuthStatus>('/auth/status'),
  setup: (input: SetupDTO) =>
    request<AuthUser>('/auth/setup', { method: 'POST', ...jsonBody(input) }),
  login: (input: LoginDTO) =>
    request<AuthUser>('/auth/login', { method: 'POST', ...jsonBody(input) }),
  logout: () =>
    request<{ success: true }>('/auth/logout', { method: 'POST' }),
  getMe: () => request<AuthUser>('/auth/me'),
  changePassword: (input: ChangePasswordDTO) =>
    request<AuthUser>('/auth/change-password', {
      method: 'POST',
      ...jsonBody(input),
    }),

  /* ----- app settings ----- */
  getSettings: () => request<AppSettings>('/settings'),
  /** which release the API is; `source` says whether the image or the package said so */
  getVersion: () =>
    request<{ version: string; source: 'build' | 'package'; node: string }>(
      '/version',
    ),
  updateSettings: (input: AppSettingsDTO) =>
    request<AppSettings>('/settings', { method: 'PUT', ...jsonBody(input) }),

  /* ----- API keys (managed signed in; a key cannot manage keys) ----- */
  listApiKeys: () => request<ApiKeyInfo[]>('/auth/api-keys'),
  /** the answer carries the key itself: this once */
  createApiKey: (input: ApiKeyInputDTO) =>
    request<ApiKeyCreated>('/auth/api-keys', { method: 'POST', ...jsonBody(input) }),
  revokeApiKey: (id: string) => request<ApiKeyInfo>(`/auth/api-keys/${id}`, { method: 'DELETE' }),

  /* ----- bridges as a file ----- */
  exportBridge: (id: string) => request<BridgeExportDocument>(`/bridges/${id}/export`),
  exportBridges: (workspaceId?: string) =>
    request<BridgeExportDocument>(
      workspaceId ? `/bridges/export?workspaceId=${encodeURIComponent(workspaceId)}` : '/bridges/export',
    ),
  importBridges: (input: BridgeImportDTO) =>
    request<BridgeImportResult>('/bridges/import', { method: 'POST', ...jsonBody(input) }),
  cloneBridge: (id: string) => request<Bridge>(`/bridges/${id}/clone`, { method: 'POST' }),

  /* ----- alert channels ----- */
  listAlertChannels: () => request<AlertChannel[]>('/alerts/channels'),
  createAlertChannel: (input: AlertChannelInput) =>
    request<AlertChannel>('/alerts/channels', { method: 'POST', ...jsonBody(input) }),
  updateAlertChannel: (id: string, input: AlertChannelInput) =>
    request<AlertChannel>(`/alerts/channels/${id}`, { method: 'PUT', ...jsonBody(input) }),
  deleteAlertChannel: (id: string) =>
    request<void>(`/alerts/channels/${id}`, { method: 'DELETE' }),
  /** sends a test message through the channel as it is stored */
  testAlertChannel: (id: string) =>
    request<AlertTestResult>(`/alerts/channels/${id}/test`, { method: 'POST' }),

  /* ----- workspaces ----- */
  listWorkspaces: () => request<Workspace[]>('/workspaces'),
  createWorkspace: (input: WorkspaceInputDTO) =>
    request<Workspace>('/workspaces', { method: 'POST', ...jsonBody(input) }),
  updateWorkspace: (id: string, input: WorkspaceInputDTO) =>
    request<Workspace>(`/workspaces/${id}`, { method: 'PUT', ...jsonBody(input) }),
  deleteWorkspace: (id: string) =>
    request<{ id: string }>(`/workspaces/${id}`, { method: 'DELETE' }),

  listConnections: (workspaceId?: string) =>
    request<ConnectionConfig[]>(
      workspaceId ? `/connections?workspaceId=${encodeURIComponent(workspaceId)}` : '/connections',
    ),
  getConnection: (id: string) =>
    request<ConnectionConfig>(`/connections/${id}`),
  createConnection: (input: ConnectionInputDTO) =>
    request<ConnectionConfig>('/connections', {
      method: 'POST',
      ...jsonBody(input),
    }),
  updateConnection: (id: string, input: ConnectionInputDTO) =>
    request<ConnectionConfig>(`/connections/${id}`, {
      method: 'PUT',
      ...jsonBody(input),
    }),
  deleteConnection: (id: string) =>
    request<{ id: string }>(`/connections/${id}`, { method: 'DELETE' }),
  /**
   * try a connection that is not (or not yet) saved. when it is an EDIT of a
   * saved one, pass its id: secrets the form only holds redacted are then taken
   * from the stored connection, so testing does not require retyping them
   */
  testConnection: (input: ConnectionInputDTO, editingId?: string) =>
    request<{ success: true; sshHostKey?: string }>(
      `/connections/test${editingId ? `?from=${encodeURIComponent(editingId)}` : ''}`,
      { method: 'POST', ...jsonBody(input) },
    ),
  testSavedConnection: (id: string) =>
    request<{ success: true; sshHostKey?: string }>(`/connections/${id}/test`, { method: 'POST' }),

  listDatabases: (id: string) =>
    request<string[]>(`/connections/${id}/databases`),
  getSchema: (id: string, database?: string) =>
    request<DatabaseSchema>(`/connections/${id}/schema${dbQuery(database)}`),
  browse: (id: string, params: BrowseParams, database?: string) =>
    request<BrowseResult>(`/connections/${id}/browse${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody(params),
    }),
  runQuery: (
    id: string,
    statement: string,
    params?: unknown[],
    database?: string,
  ) =>
    request<QueryResult>(`/connections/${id}/query${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody({ statement, params }),
    }),
  insertRow: (id: string, params: InsertRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody(params),
    }),
  updateRow: (id: string, params: UpdateRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'PATCH',
      ...jsonBody(params),
    }),
  deleteRow: (id: string, params: DeleteRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'DELETE',
      ...jsonBody(params),
    }),

  createDatabase: (id: string, name: string) =>
    request<{ success: true }>(`/connections/${id}/ddl/database`, {
      method: 'POST',
      ...jsonBody({ name }),
    }),
  dropDatabase: (id: string, name: string) =>
    request<{ success: true }>(`/connections/${id}/ddl/drop-database`, {
      method: 'POST',
      ...jsonBody({ name }),
    }),
  createTable: (id: string, spec: CreateTableSpec, database?: string) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(spec) },
    ),
  dropTable: (
    id: string,
    table: string,
    schema?: string,
    database?: string,
  ) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/drop-table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody({ table, schema }) },
    ),
  truncateTable: (
    id: string,
    table: string,
    schema?: string,
    database?: string,
  ) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/truncate-table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody({ table, schema }) },
    ),

  backup: (
    id: string,
    opts: { format: 'json' | 'sql'; tables?: string[]; schema?: string },
    database?: string,
  ) =>
    request<{ filename: string; format: string; content: string }>(
      `/connections/${id}/backup${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(opts) },
    ),
  restore: (
    id: string,
    body: { format: 'json' | 'sql'; content: string },
    database?: string,
  ) =>
    request<{ tables: number; rows: number }>(
      `/connections/${id}/restore${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(body) },
    ),

  /* ----- bridges ----- */

  listBridges: (workspaceId?: string) =>
    request<Bridge[]>(
      workspaceId ? `/bridges?workspaceId=${encodeURIComponent(workspaceId)}` : '/bridges',
    ),
  listBridgeStatuses: (workspaceId: string) =>
    request<{ bridgeId: string; active: boolean; lastStatus: string }[]>(
      `/bridges/statuses?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  getBridge: (id: string) => request<Bridge>(`/bridges/${id}`),
  createBridge: (input: BridgeInputDTO) =>
    request<Bridge>('/bridges', { method: 'POST', ...jsonBody(input) }),
  updateBridge: (id: string, input: BridgeInputDTO) =>
    request<Bridge>(`/bridges/${id}`, { method: 'PUT', ...jsonBody(input) }),
  deleteBridge: (id: string) =>
    request<{ id: string }>(`/bridges/${id}`, { method: 'DELETE' }),
  /** a dry run of a bridge that is not saved: nothing is created or delivered */
  previewDraft: (bridge: BridgeInputDTO, limit = 3) =>
    request<BridgePreview>('/bridges/preview', {
      method: 'POST',
      ...jsonBody({ bridge, limit }),
    }),
  previewBridge: (id: string, body: BridgePreviewDTO) =>
    request<BridgePreview>(`/bridges/${id}/preview`, {
      method: 'POST',
      ...jsonBody(body),
    }),
  startBridgeJob: (
    id: string,
    opts: { resumeJobId?: string; jobId?: string; retryFailedOf?: string } = {},
  ) =>
    request<BridgeJob>(`/bridges/${id}/jobs`, {
      method: 'POST',
      ...jsonBody(opts),
    }),
  listBridgeJobs: (id: string) => request<BridgeJob[]>(`/bridges/${id}/jobs`),
  getBridgeJob: (id: string, jobId: string) =>
    request<BridgeJob>(`/bridges/${id}/jobs/${jobId}`),
  cancelBridgeJob: (id: string, jobId: string) =>
    request<BridgeJob>(`/bridges/${id}/jobs/${jobId}/cancel`, { method: 'POST' }),
  listBridgeDeliveries: (
    id: string,
    jobId: string,
    opts: {
      status?: 'success' | 'failed' | 'skipped';
      from?: number;
      to?: number;
      offset?: number;
      limit?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.from != null) q.set('from', String(opts.from));
    if (opts.to != null) q.set('to', String(opts.to));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.limit != null) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<BridgeDelivery[]>(
      `/bridges/${id}/jobs/${jobId}/deliveries${qs ? `?${qs}` : ''}`,
    );
  },
  skipBridgeJob: (id: string, jobId: string, sequences: number[]) =>
    request<{ skipped: number }>(`/bridges/${id}/jobs/${jobId}/skip`, {
      method: 'POST',
      ...jsonBody({ sequences }),
    }),
  /**
   * `fromNow`: the bridge's place in the source's change log is gone, and the
   * caller accepts that what happened in between will not be captured
   */
  startWatch: (id: string, opts: { fromNow?: boolean; recopy?: boolean } = {}) =>
    request<BridgeJob>(`/bridges/${id}/watch/start`, {
      method: 'POST',
      ...jsonBody(opts),
    }),
  /** what a CDC bridge is holding on its source; null when nothing */
  sourceHold: (id: string) =>
    request<BridgeSourceHold | null>(`/bridges/${id}/source-hold`),
  /** has the source table changed since the bridge was set up? reads, changes nothing */
  schemaDrift: (id: string) => request<BridgeSchemaDrift>(`/bridges/${id}/schema-drift`),
  /** refused (400, reason `schema-drift`) while the bridge still uses a column that is gone */
  acceptSchemaDrift: (id: string) =>
    request<BridgeSchemaDrift>(`/bridges/${id}/schema-drift/accept`, { method: 'POST' }),
  stopWatch: (id: string) =>
    request<BridgeJob | null>(`/bridges/${id}/watch/stop`, { method: 'POST' }),
  cdcReadiness: (body: CdcReadinessDTO) =>
    request<CdcReadiness>('/bridges/cdc/readiness', { method: 'POST', ...jsonBody(body) }),
  retryFailedDeliveries: (id: string, jobId: string) =>
    request<BridgeJob>(`/bridges/${id}/jobs/${jobId}/retry-failed`, { method: 'POST' }),
  /** retry ONE failed delivery, now */
  retryDelivery: (id: string, jobId: string, sequence: number) =>
    request<BridgeDelivery>(`/bridges/${id}/jobs/${jobId}/deliveries/${sequence}/retry`, {
      method: 'POST',
    }),
  /** where a job's failed deliveries download from (the session cookie goes with a same-origin link) */
  failuresUrl: (id: string, jobId: string, format: 'csv' | 'ndjson') =>
    `${BASE_URL}/bridges/${id}/jobs/${jobId}/failures?format=${format}`,

  /* ----- dead letters: rows a live bridge set aside instead of losing ----- */

  listDeadLetters: (
    id: string,
    opts: { status?: DeadLetterStatus; offset?: number; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.limit != null) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<DeadLetterPage>(`/bridges/${id}/dead-letters${qs ? `?${qs}` : ''}`);
  },
  retryDeadLetters: (id: string, body: { ids?: string[]; force?: boolean } = {}) =>
    request<DeadLetterRetryResult>(`/bridges/${id}/dead-letters/retry`, {
      method: 'POST',
      ...jsonBody(body),
    }),
  discardDeadLetters: (id: string, body: { ids?: string[] } = {}) =>
    request<{ discarded: number }>(`/bridges/${id}/dead-letters/discard`, {
      method: 'POST',
      ...jsonBody(body),
    }),
};

function dbQuery(database?: string): string {
  return database ? `?database=${encodeURIComponent(database)}` : '';
}
