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
  BridgeInputDTO,
  BridgeJob,
  LoginDTO,
  SetupDTO,
  WorkspaceInputDTO,
} from '@syncle/core';
import { api } from './api';
import { useStudio } from './store';

export const queryKeys = {
  authStatus: ['auth', 'status'] as const,
  settings: ['settings'] as const,
  version: ['version'] as const,
  drivers: ['drivers'] as const,
  workspaces: ['workspaces'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  databases: (id: string) => ['connections', id, 'databases'] as const,
  schema: (id: string, database?: string) =>
    ['connections', id, 'schema', database ?? 'default'] as const,
  browse: (id: string, database: string | undefined, params: BrowseParams) =>
    ['connections', id, 'browse', database ?? 'default', params] as const,
  bridges: ['bridges'] as const,
  bridge: (id: string) => ['bridges', id] as const,
  bridgeJobs: (id: string) => ['bridges', id, 'jobs'] as const,
  bridgeJob: (id: string, jobId: string) => ['bridges', id, 'jobs', jobId] as const,
  deadLetters: (id: string) => ['bridges', id, 'deadLetters'] as const,
  sourceHold: (id: string) => ['bridges', id, 'sourceHold'] as const,
  bridgeDeliveries: (id: string, jobId: string) =>
    ['bridges', id, 'jobs', jobId, 'deliveries'] as const,
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

/** the running API's version. it cannot change without a restart */
export function useVersion() {
  return useQuery({
    queryKey: queryKeys.version,
    queryFn: () => api.getVersion(),
    staleTime: Infinity,
    retry: false,
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
      // a workspace delete cascades to its connections + bridges
      qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      qc.invalidateQueries({ queryKey: queryKeys.bridges });
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

/* ----- automation bridges ----- */

/** bridges in the active workspace */
export function useBridges() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: [...queryKeys.bridges, workspaceId],
    queryFn: () => api.listBridges(workspaceId ?? undefined),
    enabled: !!workspaceId,
  });
}

/** latest job status per bridge — polled so the map colors stay live */
export function useBridgeStatuses() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: ['bridgeStatuses', workspaceId],
    queryFn: () => api.listBridgeStatuses(workspaceId as string),
    enabled: !!workspaceId,
    refetchInterval: 3000,
  });
}

export function useCreateBridge() {
  const qc = useQueryClient();
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useMutation({
    // stamp the active workspace so a new bridge belongs to the current one
    mutationFn: (input: BridgeInputDTO) =>
      api.createBridge({ ...input, workspaceId: input.workspaceId ?? workspaceId ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bridges }),
  });
}

export function useUpdateBridge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BridgeInputDTO }) =>
      api.updateBridge(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bridges }),
  });
}

export function useDeleteBridge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteBridge(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bridges }),
  });
}

/** the element shape of the polled `['bridgeStatuses', workspaceId]` lists */
interface BridgeStatus {
  bridgeId: string;
  active: boolean;
  lastStatus: string;
}

/** upsert the authoritative job into the jobs list so the UI updates instantly */
function upsertBridgeJob(qc: QueryClient, bridgeId: string, job: BridgeJob) {
  qc.setQueryData<BridgeJob[]>(queryKeys.bridgeJobs(bridgeId), (old = []) => [
    job,
    ...old.filter((r) => r.id !== job.id),
  ]);
}

/** patch a bridge's status across every workspace's status list */
function patchBridgeStatus(
  qc: QueryClient,
  bridgeId: string,
  patch: { active: boolean; lastStatus: string },
) {
  qc.setQueriesData<BridgeStatus[]>({ queryKey: ['bridgeStatuses'] }, (old) =>
    old?.map((s) => (s.bridgeId === bridgeId ? { ...s, ...patch } : s)),
  );
}

export function useStartBridgeJob(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      opts: {
        resumeJobId?: string;
        jobId?: string;
        retryFailedOf?: string;
      } = {},
    ) => api.startBridgeJob(bridgeId, opts),
    // write the returned job into the cache first so the sidebar badge and job
    // list update instantly, then invalidate to reconcile with the server
    onSuccess: (job) => {
      upsertBridgeJob(qc, bridgeId, job);
      patchBridgeStatus(qc, bridgeId, { active: true, lastStatus: job.status });
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
      qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
    },
  });
}

export function useStartWatch(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { fromNow?: boolean; recopy?: boolean } = {}) =>
      api.startWatch(bridgeId, opts),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: queryKeys.sourceHold(bridgeId) });
      upsertBridgeJob(qc, bridgeId, job);
      patchBridgeStatus(qc, bridgeId, { active: true, lastStatus: job.status });
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
      qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
    },
  });
}

export function useStopWatch(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopWatch(bridgeId),
    // stop returns null when nothing was watching — nothing to write then
    onSuccess: (job) => {
      if (job) {
        upsertBridgeJob(qc, bridgeId, job);
        patchBridgeStatus(qc, bridgeId, { active: false, lastStatus: job.status });
      }
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
      qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
    },
  });
}

export function useRetryFailed(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.retryFailedDeliveries(bridgeId, jobId),
    onSuccess: (_d, jobId) => {
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
      qc.invalidateQueries({
        queryKey: queryKeys.bridgeDeliveries(bridgeId, jobId),
      });
      // on a live bridge this retries the dead-letter queue
      qc.invalidateQueries({ queryKey: queryKeys.deadLetters(bridgeId) });
      qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
    },
  });
}

/**
 * rows the bridge set aside instead of losing. polled while the bridge is live
 * (new ones can arrive at any moment), otherwise fetched once.
 */
export function useDeadLetters(bridgeId: string | null, live: boolean) {
  return useQuery({
    queryKey: bridgeId ? queryKeys.deadLetters(bridgeId) : ['deadLetters', 'none'],
    queryFn: () => api.listDeadLetters(bridgeId as string, { status: 'pending', limit: 100 }),
    enabled: !!bridgeId,
    refetchInterval: live ? 5000 : false,
  });
}

/**
 * what a CDC bridge is holding on its source (PostgreSQL: WAL pinned by its
 * replication slot). it matters most when the bridge is NOT running — that is
 * when it only grows — so it is polled either way, just slowly
 */
export function useSourceHold(bridgeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: bridgeId ? queryKeys.sourceHold(bridgeId) : ['sourceHold', 'none'],
    queryFn: () => api.sourceHold(bridgeId as string),
    enabled: !!bridgeId && enabled,
    refetchInterval: 30_000,
    // the source may be unreachable; that is reported elsewhere, louder
    retry: false,
  });
}

/** a retry can turn failed deliveries green, so the job + timeline refresh too */
function invalidateAfterDeadLetterChange(qc: QueryClient, bridgeId: string) {
  qc.invalidateQueries({ queryKey: queryKeys.deadLetters(bridgeId) });
  qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
  qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
}

export function useRetryDeadLetters(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; force?: boolean }) =>
      api.retryDeadLetters(bridgeId, body),
    // a partial result is still progress: refresh whether it resolved or not
    onSettled: () => invalidateAfterDeadLetterChange(qc, bridgeId),
  });
}

export function useDiscardDeadLetters(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[] }) => api.discardDeadLetters(bridgeId, body),
    onSettled: () => invalidateAfterDeadLetterChange(qc, bridgeId),
  });
}

export function useCancelBridgeJob(bridgeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelBridgeJob(bridgeId, jobId),
    onSuccess: (job) => {
      upsertBridgeJob(qc, bridgeId, job);
      patchBridgeStatus(qc, bridgeId, { active: false, lastStatus: job.status });
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
      qc.invalidateQueries({ queryKey: ['bridgeStatuses'] });
    },
  });
}

/** live-polls while any job is still active */
export function useBridgeJobs(bridgeId: string | null) {
  return useQuery({
    queryKey: bridgeId ? queryKeys.bridgeJobs(bridgeId) : ['bridgeJobs', 'none'],
    queryFn: () => api.listBridgeJobs(bridgeId as string),
    enabled: !!bridgeId,
    refetchInterval: (query) => {
      const jobs = query.state.data as BridgeJob[] | undefined;
      const active = jobs?.some((r) =>
        ['queued', 'running', 'canceling'].includes(r.status),
      );
      return active ? 1500 : false;
    },
  });
}

export function useBridgeDeliveries(
  bridgeId: string | null,
  jobId: string | null,
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
      bridgeId && jobId
        ? [...queryKeys.bridgeDeliveries(bridgeId, jobId), opts]
        : ['bridgeDeliveries', 'none'],
    queryFn: () =>
      api.listBridgeDeliveries(bridgeId as string, jobId as string, {
        // default cap for range (from/to) windows; offset windows pass their
        // own page-size limit
        limit: 2000,
        ...opts,
      }),
    enabled: !!bridgeId && !!jobId,
    refetchInterval: live ? 1500 : false,
    staleTime: 0,
  });

  // when a job goes from active to terminal, invalidate every window so
  // deliveries written between the last poll and completion show up (the
  // active query refetches immediately, siblings on next mount)
  useEffect(() => {
    if (prevLiveRef.current && !live && bridgeId && jobId) {
      void qc.invalidateQueries({
        queryKey: queryKeys.bridgeDeliveries(bridgeId, jobId),
      });
    }
    prevLiveRef.current = live;
  }, [live, bridgeId, jobId, qc]);

  return query;
}

export function useSkipDeliveries(bridgeId: string, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sequences: number[]) =>
      api.skipBridgeJob(bridgeId, jobId, sequences),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.bridgeDeliveries(bridgeId, jobId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.bridgeJobs(bridgeId) });
    },
  });
}
