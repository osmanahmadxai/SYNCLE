/**
 * typed client for the Syncle NestJS API. unwraps the `{ data }` envelope,
 * throws a structured {@link ApiError} on `{ error }` responses
 */
import type {
  AppSettings,
  AppSettingsDTO,
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
  updateSettings: (input: AppSettingsDTO) =>
    request<AppSettings>('/settings', { method: 'PUT', ...jsonBody(input) }),

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
  testConnection: (input: ConnectionInputDTO) =>
    request<{ success: true }>('/connections/test', {
      method: 'POST',
      ...jsonBody(input),
    }),
  testSavedConnection: (id: string) =>
    request<{ success: true }>(`/connections/${id}/test`, { method: 'POST' }),

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
  startWatch: (id: string) =>
    request<BridgeJob>(`/bridges/${id}/watch/start`, { method: 'POST' }),
  stopWatch: (id: string) =>
    request<BridgeJob | null>(`/bridges/${id}/watch/stop`, { method: 'POST' }),
  cdcReadiness: (body: CdcReadinessDTO) =>
    request<CdcReadiness>('/bridges/cdc/readiness', { method: 'POST', ...jsonBody(body) }),
  retryFailedDeliveries: (id: string, jobId: string) =>
    request<BridgeJob>(`/bridges/${id}/jobs/${jobId}/retry-failed`, { method: 'POST' }),
};

function dbQuery(database?: string): string {
  return database ? `?database=${encodeURIComponent(database)}` : '';
}
