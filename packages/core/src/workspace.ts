/**
 * workspaces are the top-level container, an ecosystem that owns connections and
 * bridges. everything a user creates lives inside one. there's always a
 * default workspace so the concept stays invisible until you want a second one.
 */
import { z } from 'zod';

/** the always-present default workspace every install starts with */
export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

export const workspaceInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  color: z.string().optional(),
});

export type WorkspaceInputDTO = z.infer<typeof workspaceInputSchema>;

/** a workspace as returned by the API */
export interface Workspace {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}
