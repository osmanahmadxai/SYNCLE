'use client';

import { useEffect, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AppSettingsDTO,
  BrowseParams,
  ChangePasswordDTO,
  ConnectionInputDTO,
  HookInputDTO,
  HookRun,
  LoginDTO,
  SetupDTO,
  WorkspaceInputDTO,
} from '@syncle/core';
import { api } from './api';
import { useStudio } from './store';

export const queryKeys = {
  authStatus: ['auth', 'status'] as const,
  settings: ['settings'] as const,
  drivers: ['drivers'] as const,
  workspaces: ['workspaces'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  databases: (id: string) => ['connections', id, 'databases'] as const,
  schema: (id: string, database?: string) =>
    ['connections', id, 'schema', database ?? 'default'] as const,
  browse: (id: string, database: string | undefined, params: BrowseParams) =>
    ['connections', id, 'browse', database ?? 'default', params] as const,
  hooks: ['hooks'] as const,
  hook: (id: string) => ['hooks', id] as const,
  hookRuns: (id: string) => ['hooks', id, 'runs'] as const,
  hookRun: (id: string, runId: string) => ['hooks', id, 'runs', runId] as const,
  hookDeliveries: (id: string, runId: string) =>
    ['hooks', id, 'runs', runId, 'deliveries'] as const,
};

/* ----- auth ----- */

/** public probe that decides which screen (setup / login / app) to render */
export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.authStatus,
    queryFn: () => api.listAuthStatus(),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginDTO) => api.login(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.authStatus }),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupDTO) => api.setup(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.authStatus }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    // flip AuthGate back to the login screen immediately: drop every cached
    // query from the previous session EXCEPT the auth-status probe (removing it
    // would leave its mounted observer with nothing to refetch), then invalidate
    // that probe so it re-runs and reports the logged-out state
    onSuccess: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      qc.invalidateQueries({ queryKey: queryKeys.authStatus });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordDTO) => api.changePassword(input),
  });
}

/* ----- app settings ----- */

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.getSettings(),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AppSettingsDTO) => api.updateSettings(input),
    onSuccess: (settings) => {
      qc.setQueryData(queryKeys.settings, settings);
      qc.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useDrivers() {
  return useQuery({
    queryKey: queryKeys.drivers,
    queryFn: () => api.listDrivers(),
    staleTime: Infinity,
  });
}

/* ----- workspaces ----- */

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.listWorkspaces(),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkspaceInputDTO) => api.createWorkspace(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WorkspaceInputDTO }) =>
      api.updateWorkspace(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => {
      // a workspace delete cascades to its connections + hooks
      qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      qc.invalidateQueries({ queryKey: queryKeys.hooks });
    },
  });
}

/** connections in the active workspace (the key carries the id so it refetches) */
export function useConnections() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: [...queryKeys.connections, workspaceId],
    queryFn: () => api.listConnections(workspaceId ?? undefined),
    enabled: !!workspaceId,
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useMutation({
    // stamp the active workspace so new connections land where the user is
    mutationFn: (input: ConnectionInputDTO) =>
      api.createConnection({ ...input, workspaceId: input.workspaceId ?? workspaceId ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ConnectionInputDTO }) =>
      api.updateConnection(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useSchema(id: string | null, database?: string) {
  return useQuery({
    queryKey: id ? queryKeys.schema(id, database) : ['schema', 'none'],
    queryFn: () => api.getSchema(id as string, database),
    enabled: !!id,
  });
}

export function useDatabases(id: string | null) {
  return useQuery({
    queryKey: id ? queryKeys.databases(id) : ['databases', 'none'],
    queryFn: () => api.listDatabases(id as string),
    enabled: !!id,
  });
}

export function useBrowse(
  id: string | null,
  params: BrowseParams | null,
  database?: string,
) {
  return useQuery({
    queryKey:
      id && params
        ? queryKeys.browse(id, database, params)
        : ['browse', 'none'],
    queryFn: () => api.browse(id as string, params as BrowseParams, database),
    enabled: !!id && !!params,
    placeholderData: (prev) => prev,
  });
}

/* ----- automation hooks ----- */

/** bridges (hooks) in the active workspace */
export function useHooks() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: [...queryKeys.hooks, workspaceId],
    queryFn: () => api.listHooks(workspaceId ?? undefined),
    enabled: !!workspaceId,
  });
}

/** latest run status per bridge — polled so the map colors stay live */
export function useHookStatuses() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: ['hookStatuses', workspaceId],
    queryFn: () => api.listHookStatuses(workspaceId as string),
    enabled: !!workspaceId,
    refetchInterval: 3000,
  });
}

export function useCreateHook() {
  const qc = useQueryClient();
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useMutation({
    // stamp the active workspace so a new bridge belongs to the current one
    mutationFn: (input: HookInputDTO) =>
      api.createHook({ ...input, workspaceId: input.workspaceId ?? workspaceId ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

export function useUpdateHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: HookInputDTO }) =>
      api.updateHook(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

export function useDeleteHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteHook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

/** the element shape of the polled `['hookStatuses', workspaceId]` lists */
interface HookStatus {
  hookId: string;
  active: boolean;
  lastStatus: string;
}

/** upsert the authoritative run into the runs list so the UI updates instantly */
function upsertHookRun(qc: QueryClient, hookId: string, run: HookRun) {
  qc.setQueryData<HookRun[]>(queryKeys.hookRuns(hookId), (old = []) => [
    run,
    ...old.filter((r) => r.id !== run.id),
  ]);
}

/** patch a bridge's status across every workspace's status list */
function patchHookStatus(
  qc: QueryClient,
  hookId: string,
  patch: { active: boolean; lastStatus: string },
) {
  qc.setQueriesData<HookStatus[]>({ queryKey: ['hookStatuses'] }, (old) =>
    old?.map((s) => (s.hookId === hookId ? { ...s, ...patch } : s)),
  );
}

export function useStartHookRun(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      opts: {
        resumeRunId?: string;
        runId?: string;
        retryFailedOf?: string;
      } = {},
    ) => api.startHookRun(hookId, opts),
    // write the returned run into the cache first so the sidebar badge and run
    // list update instantly, then invalidate to reconcile with the server
    onSuccess: (run) => {
      upsertHookRun(qc, hookId, run);
      patchHookStatus(qc, hookId, { active: true, lastStatus: run.status });
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useStartWatch(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startWatch(hookId),
    onSuccess: (run) => {
      upsertHookRun(qc, hookId, run);
      patchHookStatus(qc, hookId, { active: true, lastStatus: run.status });
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useStopWatch(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopWatch(hookId),
    // stop returns null when nothing was watching — nothing to write then
    onSuccess: (run) => {
      if (run) {
        upsertHookRun(qc, hookId, run);
        patchHookStatus(qc, hookId, { active: false, lastStatus: run.status });
      }
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useRetryFailed(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.retryFailedDeliveries(hookId, runId),
    onSuccess: (_d, runId) => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useCancelHookRun(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelHookRun(hookId, runId),
    onSuccess: (run) => {
      upsertHookRun(qc, hookId, run);
      patchHookStatus(qc, hookId, { active: false, lastStatus: run.status });
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

/** live-polls while any run is still active */
export function useHookRuns(hookId: string | null) {
  return useQuery({
    queryKey: hookId ? queryKeys.hookRuns(hookId) : ['hookRuns', 'none'],
    queryFn: () => api.listHookRuns(hookId as string),
    enabled: !!hookId,
    refetchInterval: (query) => {
      const runs = query.state.data as HookRun[] | undefined;
      const active = runs?.some((r) =>
        ['queued', 'running', 'canceling'].includes(r.status),
      );
      return active ? 1500 : false;
    },
  });
}

export function useHookDeliveries(
  hookId: string | null,
  runId: string | null,
  live: boolean,
  opts: {
    status?: 'success' | 'failed' | 'skipped';
    from?: number;
    to?: number;
    offset?: number;
    limit?: number;
  } = {},
) {
  const qc = useQueryClient();
  const prevLiveRef = useRef(live);

  const query = useQuery({
    queryKey:
      hookId && runId
        ? [...queryKeys.hookDeliveries(hookId, runId), opts]
        : ['hookDeliveries', 'none'],
    queryFn: () =>
      api.listHookDeliveries(hookId as string, runId as string, {
        // default cap for range (from/to) windows; offset windows pass their
        // own page-size limit
        limit: 2000,
        ...opts,
      }),
    enabled: !!hookId && !!runId,
    refetchInterval: live ? 1500 : false,
    staleTime: 0,
  });

  // when a run goes from active to terminal, invalidate every window so
  // deliveries written between the last poll and completion show up (the
  // active query refetches immediately, siblings on next mount)
  useEffect(() => {
    if (prevLiveRef.current && !live && hookId && runId) {
      void qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
    }
    prevLiveRef.current = live;
  }, [live, hookId, runId, qc]);

  return query;
}

export function useSkipDeliveries(hookId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sequences: number[]) =>
      api.skipHookRun(hookId, runId, sequences),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
    },
  });
}
