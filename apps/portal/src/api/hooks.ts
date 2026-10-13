import type {
  AppInfo,
  ArtifactDto,
  AuditLogDto,
  BuildDto,
  CreateHostRequest,
  CreateUserRequest,
  DeviceDto,
  HostDto,
  HostTokenDto,
  Paginated,
  ProjectDto,
  PublicSettingsDto,
  ReservationDto,
  SessionDto,
  TeamDto,
  UpdateDeviceRequest,
  UpdateUserRequest,
  UserDto,
} from '@devicelab/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const qk = {
  devices: ['devices'] as const,
  device: (id: string) => ['device', id] as const,
  hosts: ['hosts'] as const,
  reservations: (scope: string) => ['reservations', scope] as const,
  reservation: (id: string) => ['reservation', id] as const,
  activeSessions: ['sessions', 'active'] as const,
  projects: ['projects'] as const,
  teams: ['teams'] as const,
  users: ['users'] as const,
  builds: ['builds'] as const,
  artifacts: (sessionId?: string) => ['artifacts', sessionId ?? 'mine'] as const,
  apps: (deviceId: string) => ['apps', deviceId] as const,
  audit: (q: string) => ['audit', q] as const,
  settings: ['settings'] as const,
};

export const useDevices = () =>
  useQuery({ queryKey: qk.devices, queryFn: () => api<DeviceDto[]>('/devices') });
export const useDevice = (id: string | undefined) =>
  useQuery({
    queryKey: qk.device(id ?? ''),
    queryFn: () => api<DeviceDto & { details: Record<string, unknown> | null }>(`/devices/${id}`),
    enabled: Boolean(id),
  });
export const useHosts = () =>
  useQuery({ queryKey: qk.hosts, queryFn: () => api<HostDto[]>('/hosts') });
export const useProjects = () =>
  useQuery({
    queryKey: qk.projects,
    queryFn: () => api<ProjectDto[]>('/projects'),
    staleTime: 60_000,
  });
export const useTeams = () =>
  useQuery({ queryKey: qk.teams, queryFn: () => api<TeamDto[]>('/teams'), staleTime: 60_000 });
export const useUsers = (enabled = true) =>
  useQuery({ queryKey: qk.users, queryFn: () => api<UserDto[]>('/users'), enabled });
export const useBuilds = () =>
  useQuery({ queryKey: qk.builds, queryFn: () => api<BuildDto[]>('/builds') });
export const useSettings = () =>
  useQuery({
    queryKey: qk.settings,
    queryFn: () => api<PublicSettingsDto>('/settings/public'),
    staleTime: 300_000,
  });
export const useReservations = (scope: 'mine' | 'active-all' = 'mine', enabled = true) =>
  useQuery({
    queryKey: qk.reservations(scope),
    queryFn: () => api<ReservationDto[]>(`/reservations?scope=${scope}`),
    enabled,
  });
export const useReservation = (id: string | undefined) =>
  useQuery({
    queryKey: qk.reservation(id ?? ''),
    queryFn: () => api<ReservationDto>(`/reservations/${id}`),
    enabled: Boolean(id),
  });
export const useActiveSessions = (enabled: boolean) =>
  useQuery({
    queryKey: qk.activeSessions,
    queryFn: () =>
      api<(SessionDto & { userName: string; deviceModel: string })[]>('/sessions/active'),
    enabled,
    refetchInterval: 15_000,
  });
export const useArtifacts = (sessionId?: string) =>
  useQuery({
    queryKey: qk.artifacts(sessionId),
    queryFn: () =>
      api<ArtifactDto[]>(sessionId ? `/artifacts?sessionId=${sessionId}` : '/artifacts'),
  });
export const useApps = (deviceId: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.apps(deviceId),
    queryFn: () => api<AppInfo[]>(`/devices/${deviceId}/apps`),
    enabled,
    retry: 1,
  });
export const useAudit = (query: string) =>
  useQuery({
    queryKey: qk.audit(query),
    queryFn: () => api<Paginated<AuditLogDto>>(`/audit?${query}`),
  });

export function useReserve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { deviceId: string; durationMinutes?: number; purpose?: string }) =>
      api<ReservationDto>('/reservations', { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: qk.devices });
    },
  });
}

export function useRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reservationId: string) =>
      api<ReservationDto>(`/reservations/${reservationId}/release`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: qk.devices });
    },
  });
}

export function useExtend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) =>
      api<ReservationDto>(`/reservations/${id}/extend`, { body: { minutes } }),
    onSuccess: (r) => {
      qc.setQueryData(qk.reservation(r.id), r);
      void qc.invalidateQueries({ queryKey: ['reservations'] });
    },
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateDeviceRequest }) =>
      api<DeviceDto>(`/devices/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.devices }),
  });
}

export function useDeviceCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'reboot' | 'remove' }) =>
      action === 'reboot'
        ? api(`/devices/${id}/reboot`, { method: 'POST' })
        : api(`/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.devices }),
  });
}

export function useCreateHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHostRequest) => api<HostTokenDto>('/hosts', { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.hosts }),
  });
}

export function useHostAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'revoke' | 'rotate-token' | 'resync' }) =>
      api<HostTokenDto | HostDto | undefined>(`/hosts/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.hosts }),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserRequest) => api<UserDto>('/users', { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) =>
      api<UserDto>(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.users }),
  });
}
