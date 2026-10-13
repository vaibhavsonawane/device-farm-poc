import { Role } from '@devicelab/shared-types';
import { type Prisma } from '@prisma/client';
import { type AuthUser } from './auth.decorators';

/**
 * Project scoping: a device or build assigned to a project is visible only to
 * members of the project's team (admins see everything). Unassigned items and
 * projects without a team are visible to everyone with the base permission.
 */
export function canAccessProject(
  user: Pick<AuthUser, 'role' | 'teamId'>,
  project: { teamId: string | null } | null | undefined,
): boolean {
  if (user.role === Role.ADMIN) return true;
  if (!project || !project.teamId) return true;
  return project.teamId === user.teamId;
}

/** Prisma filter equivalent of canAccessProject, for list queries on models with a `project` relation. */
export function projectScopeWhere(
  user: Pick<AuthUser, 'role' | 'teamId'>,
): Prisma.DeviceWhereInput & Prisma.BuildWhereInput {
  if (user.role === Role.ADMIN) return {};
  return {
    OR: [
      { projectId: null },
      { project: { teamId: null } },
      ...(user.teamId ? [{ project: { teamId: user.teamId } }] : []),
    ],
  };
}
