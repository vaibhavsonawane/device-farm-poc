import type {
  Artifact,
  Build,
  Device,
  Host,
  Project,
  Reservation,
  Session,
  Team,
  User,
} from '@prisma/client';
import type {
  ArtifactDto,
  BuildDto,
  DeviceDto,
  HostCapabilities,
  HostDto,
  ProjectDto,
  ReservationDto,
  SessionDto,
  UserDto,
} from '@devicelab/shared-types';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toUserDto(u: User & { team?: Team | null }): UserDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    teamId: u.teamId,
    teamName: u.team?.name ?? null,
    isActive: u.isActive,
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: u.createdAt.toISOString(),
  };
}

export function toProjectDto(p: Project): ProjectDto {
  return { id: p.id, name: p.name, code: p.code, teamId: p.teamId };
}

export function toHostDto(h: Host & { _count?: { devices: number } }): HostDto {
  return {
    id: h.id,
    name: h.name,
    os: h.os,
    ip: h.ip,
    agentVersion: h.agentVersion,
    status: h.status,
    lastSeenAt: iso(h.lastSeenAt),
    capabilities: (h.capabilities as HostCapabilities | null) ?? null,
    deviceCount: h._count?.devices ?? 0,
    createdAt: h.createdAt.toISOString(),
  };
}

export type DeviceWithRelations = Device & {
  host: Pick<Host, 'name'>;
  project: Pick<Project, 'name'> | null;
  reservations: (Reservation & { user: Pick<User, 'name'> })[];
};

/** Prisma include that yields DeviceWithRelations. */
export const deviceInclude = {
  host: { select: { name: true } },
  project: { select: { name: true } },
  reservations: {
    where: { status: 'ACTIVE' as const },
    include: { user: { select: { name: true } } },
    take: 1,
  },
};

export function toDeviceDto(d: DeviceWithRelations): DeviceDto {
  const r = d.reservations[0];
  return {
    id: d.id,
    udid: d.udid,
    platform: d.platform,
    name: d.name,
    model: d.model,
    manufacturer: d.manufacturer,
    osVersion: d.osVersion,
    screenW: d.screenW,
    screenH: d.screenH,
    hostId: d.hostId,
    hostName: d.host.name,
    status: d.status,
    tags: d.tags,
    projectId: d.projectId,
    projectName: d.project?.name ?? null,
    batteryLevel: d.batteryLevel,
    simNumber: d.simNumber,
    notes: d.notes,
    currentReservation: r
      ? {
          id: r.id,
          userId: r.userId,
          userName: r.user.name,
          kind: r.kind,
          endAt: r.endAt.toISOString(),
        }
      : null,
    health: (d.health as DeviceDto['health']) ?? null,
    lastSeenAt: iso(d.lastSeenAt),
  };
}

export type ReservationWithRelations = Reservation & {
  device: Pick<Device, 'model'>;
  user: Pick<User, 'name'>;
  sessions: Pick<Session, 'id' | 'endedAt'>[];
};

export const reservationInclude = {
  device: { select: { model: true } },
  user: { select: { name: true } },
  sessions: { where: { endedAt: null }, select: { id: true, endedAt: true }, take: 1 },
};

export function toReservationDto(r: ReservationWithRelations): ReservationDto {
  return {
    id: r.id,
    deviceId: r.deviceId,
    deviceModel: r.device.model,
    userId: r.userId,
    userName: r.user.name,
    kind: r.kind,
    status: r.status,
    purpose: r.purpose,
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    releasedAt: iso(r.releasedAt),
    releaseReason: r.releaseReason,
    activeSessionId: r.sessions.find((s) => !s.endedAt)?.id ?? null,
  };
}

export function toSessionDto(
  s: Session & { reservation: Pick<Reservation, 'deviceId'> },
): SessionDto {
  return {
    id: s.id,
    reservationId: s.reservationId,
    deviceId: s.reservation.deviceId,
    startedAt: s.startedAt.toISOString(),
    endedAt: iso(s.endedAt),
    disconnectReason: s.disconnectReason,
  };
}

export function toBuildDto(b: Build & { uploadedBy: Pick<User, 'name'> }): BuildDto {
  return {
    id: b.id,
    projectId: b.projectId,
    platform: b.platform,
    fileName: b.fileName,
    appName: b.appName,
    version: b.version,
    buildNumber: b.buildNumber,
    packageId: b.packageId,
    sizeBytes: Number(b.sizeBytes),
    checksumSha256: b.checksumSha256,
    uploadedById: b.uploadedById,
    uploadedByName: b.uploadedBy.name,
    uploadedAt: b.uploadedAt.toISOString(),
    releaseNotes: b.releaseNotes,
  };
}

export function toArtifactDto(a: Artifact): ArtifactDto {
  return {
    id: a.id,
    sessionId: a.sessionId,
    deviceId: a.deviceId,
    type: a.type,
    fileName: a.fileName,
    sizeBytes: Number(a.sizeBytes),
    createdAt: a.createdAt.toISOString(),
  };
}
