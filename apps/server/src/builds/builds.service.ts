import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type BuildDto,
  type InstallProgress,
  type InstallRequest,
  type Platform,
} from '@devicelab/shared-types';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { type Readable } from 'node:stream';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser } from '../common/auth.decorators';
import { canAccessProject, projectScopeWhere } from '../common/access';
import { toBuildDto } from '../common/mappers';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, PortalEvents } from '../realtime/realtime.services';
import { ReservationsService } from '../reservations/reservations.service';
import { StorageService } from '../storage/storage.service';

export interface UploadedBuildFile {
  path: string;
  originalname: string;
  size: number;
}

interface InstallJob {
  userId: string;
  deviceId: string;
}

const CONTENT_TYPES: Record<Platform, string> = {
  ANDROID: 'application/vnd.android.package-archive',
  IOS: 'application/octet-stream',
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function isZip(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    await fh.close();
  }
}

/** Platform from the file name, or a helpful error. */
export function platformForFile(fileName: string): Platform {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.apk')) return 'ANDROID';
  if (lower.endsWith('.ipa')) return 'IOS';
  if (lower.endsWith('.aab')) {
    throw new BadRequestException(
      'AAB is not directly installable. Build a universal APK first: bundletool build-apks --mode=universal --bundle=app.aab --output=app.apks',
    );
  }
  throw new BadRequestException('Only .apk and .ipa files can be uploaded');
}

@Injectable()
export class BuildsService {
  private readonly logger = new Logger(BuildsService.name);
  private readonly jobs = new Map<string, InstallJob>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly reservations: ReservationsService,
    private readonly devices: DevicesService,
    private readonly agents: AgentRegistry,
    private readonly events: PortalEvents,
    private readonly audit: AuditService,
  ) {}

  async upload(
    user: AuthUser,
    file: UploadedBuildFile | undefined,
    meta: { projectId?: string | null; releaseNotes?: string | null },
    ip: string | null,
  ): Promise<BuildDto> {
    if (!file) throw new BadRequestException('Attach the build as multipart field "file"');
    try {
      const platform = platformForFile(file.originalname);
      if (!(await isZip(file.path)))
        throw new BadRequestException('File is not a valid APK/IPA (not a ZIP archive)');
      if (meta.projectId) {
        const project = await this.prisma.project.findUnique({ where: { id: meta.projectId } });
        if (!project) throw new BadRequestException('Unknown project');
        if (!canAccessProject(user, project))
          throw new ForbiddenException('You are not a member of this project');
      }
      const checksum = await sha256File(file.path);
      const id = randomUUID();
      const safeName = file.originalname.replace(/[^\w.-]+/g, '_').slice(-120);
      const storageKey = `builds/${id}/${safeName}`;
      await this.storage.putFile(storageKey, file.path, CONTENT_TYPES[platform]);
      const build = await this.prisma.build.create({
        data: {
          id,
          projectId: meta.projectId ?? null,
          platform,
          fileName: safeName,
          sizeBytes: file.size,
          storageKey,
          checksumSha256: checksum,
          releaseNotes: meta.releaseNotes ?? null,
          uploadedById: user.id,
        },
        include: { uploadedBy: { select: { name: true } } },
      });
      await this.audit.log({
        action: AuditAction.BUILD_UPLOAD,
        userId: user.id,
        entityType: 'Build',
        entityId: id,
        metadata: {
          fileName: safeName,
          sha256: checksum,
          size: file.size,
          projectId: meta.projectId ?? null,
        },
        ip,
      });
      return toBuildDto(build);
    } finally {
      await rm(file.path, { force: true });
    }
  }

  async list(user: AuthUser, projectId?: string): Promise<BuildDto[]> {
    const rows = await this.prisma.build.findMany({
      where: { AND: [projectScopeWhere(user), projectId ? { projectId } : {}] },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { uploadedAt: 'desc' },
      take: 200,
    });
    return rows.map(toBuildDto);
  }

  private async getForUser(user: AuthUser, id: string) {
    const b = await this.prisma.build.findUnique({
      where: { id },
      include: { project: true, uploadedBy: { select: { name: true } } },
    });
    if (!b) throw new NotFoundException('Build not found');
    if (!canAccessProject(user, b.project)) throw new ForbiddenException();
    return b;
  }

  async openForUser(
    user: AuthUser,
    id: string,
    ip: string | null,
  ): Promise<{ stream: Readable; fileName: string; contentType: string; size: number }> {
    const b = await this.getForUser(user, id);
    await this.audit.log({
      action: AuditAction.BUILD_DOWNLOAD,
      userId: user.id,
      entityType: 'Build',
      entityId: id,
      ip,
    });
    return {
      stream: await this.storage.get(b.storageKey),
      fileName: b.fileName,
      contentType: CONTENT_TYPES[b.platform],
      size: Number(b.sizeBytes),
    };
  }

  /** Agents fetch builds with their host token. */
  async openForAgent(
    id: string,
  ): Promise<{ stream: Readable; fileName: string; contentType: string; size: number }> {
    const b = await this.prisma.build.findUnique({ where: { id } });
    if (!b) throw new NotFoundException();
    return {
      stream: await this.storage.get(b.storageKey),
      fileName: b.fileName,
      contentType: CONTENT_TYPES[b.platform],
      size: Number(b.sizeBytes),
    };
  }

  /** Queue installs on devices the user currently holds. Progress arrives over the portal socket. */
  async install(
    user: AuthUser,
    req: InstallRequest,
    ip: string | null,
  ): Promise<{ jobs: { jobId: string; deviceId: string }[] }> {
    const build = await this.getForUser(user, req.buildId);
    const targets: {
      jobId: string;
      deviceId: string;
      serial: string;
      hostId: string;
      reservationId: string;
    }[] = [];
    for (const deviceId of new Set(req.deviceIds)) {
      const device = await this.devices.getForUser(user, deviceId);
      if (device.platform !== build.platform) {
        throw new BadRequestException(
          `${build.fileName} is a ${build.platform} build; ${device.model} is ${device.platform}`,
        );
      }
      if (!device.online) throw new ConflictException(`${device.model} is offline`);
      const r = await this.reservations.assertHolder(user, deviceId);
      targets.push({
        jobId: randomUUID(),
        deviceId,
        serial: device.udid,
        hostId: device.hostId,
        reservationId: r.id,
      });
    }
    for (const t of targets) {
      this.jobs.set(t.jobId, { userId: user.id, deviceId: t.deviceId });
      void this.runInstall(user, build, t, ip);
    }
    return { jobs: targets.map(({ jobId, deviceId }) => ({ jobId, deviceId })) };
  }

  private async runInstall(
    user: AuthUser,
    build: { id: string; fileName: string; checksumSha256: string },
    t: { jobId: string; deviceId: string; serial: string; hostId: string; reservationId: string },
    ip: string | null,
  ): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { reservationId: t.reservationId, endedAt: null },
      select: { id: true },
    });
    const res = await this.agents.command(
      t.hostId,
      'device:install',
      {
        jobId: t.jobId,
        serial: t.serial,
        sessionId: session?.id ?? null,
        buildId: build.id,
        fileName: build.fileName,
        downloadPath: `/api/agent/builds/${build.id}/file`,
        checksumSha256: build.checksumSha256,
      },
      10 * 60_000,
    );
    if (res.ok) await this.reservations.addInstalledPackages(t.reservationId, res.data.packageIds);
    this.onProgress({
      jobId: t.jobId,
      serial: t.serial,
      percent: 100,
      state: res.ok ? 'done' : 'error',
      message: res.ok ? `Installed ${res.data.packageIds.join(', ') || build.fileName}` : res.error,
    });
    await this.audit.log({
      action: AuditAction.APP_INSTALL,
      userId: user.id,
      entityType: 'Device',
      entityId: t.deviceId,
      metadata: {
        buildId: build.id,
        fileName: build.fileName,
        ok: res.ok,
        packages: res.ok ? res.data.packageIds : [],
        error: res.ok ? undefined : res.error,
      },
      ip,
    });
    this.jobs.delete(t.jobId);
  }

  onProgress(p: InstallProgress): void {
    const job = this.jobs.get(p.jobId);
    if (job) this.events.installProgress(job.userId, { ...p, deviceId: job.deviceId });
  }
}
