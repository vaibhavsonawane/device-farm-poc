import { type Permission, can } from '@devicelab/shared-types';
import { useAuth } from '../stores/auth';

/** UI-only permission check (the server enforces the real rule). */
export function usePermission(permission: Permission): boolean {
  const role = useAuth((s) => s.user?.role);
  return can(role, permission);
}
