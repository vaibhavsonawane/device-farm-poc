import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type ArtifactDto, Permission, can } from '@devicelab/shared-types';
import { randomUUID } from 'node:crypto';
import { type Readable } from 'node:stream';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser } from '../common/auth.decorators';
import { toArtifactDto } from '../common/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry } from '../realtime/realtime.services';
import { StorageService } from '../storage/storage.service';

function toBuffer(png: Uint8Array | ArrayBuffer): Buffer {
  return Buffer.isBuffer(png)
    ? png
    : Buffer.from(png instanceof ArrayBuffer ? new Uint8Array(png) : png);
}

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentRegistry,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async captureScreenshot(
    user: AuthUser,
    access: { sessionId: string; hostId: string; serial: string; deviceId: string },
    ip: string | null,
  ): Promise<ArtifactDto> {
    const res = await this.agents.command(
      access.hostId,
      'device:screenshot',
      { serial: access.serial },
      20_000,
    );
    if (!res.ok) throw new BadGatewayException(`Screenshot failed: ${res.error}`);
    const png = toBuffer(res.data.png);
    const id = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `screenshot-${stamp}.png`;
    const storageKey = `artifacts/${access.sessionId}/${id}.png`;
    await this.storage.put(storageKey, png, 'image/png');
    const a = await this.prisma.artifact.create({
      data: {
        id,
        sessionId: access.sessionId,
        deviceId: access.deviceId,
        type: 'SCREENSHOT',
        fileName,
        contentType: 'image/png',
        sizeBytes: png.byteLength,
        storageKey,
        createdById: user.id,
      },
    });
    await this.audit.log({
      action: AuditAction.ARTIFACT_CREATE,
      userId: user.id,
      entityType: 'Artifact',
      entityId: id,
      metadata: { type: 'SCREENSHOT', sessionId: access.sessionId },
      ip,
    });
    return toArtifactDto(a);
  }

  private async loadWithOwner(
    id: string,
  ): Promise<{
    artifact: Awaited<ReturnType<PrismaService['artifact']['findUniqueOrThrow']>>;
    ownerId: string | null;
  }> {
    const a = await this.prisma.artifact.findUnique({
      where: { id },
      include: { session: { include: { reservation: { select: { userId: true } } } } },
    });
    if (!a) throw new NotFoundException();
    return { artifact: a, ownerId: a.session?.reservation.userId ?? a.createdById };
  }

  private assertCanRead(user: AuthUser, ownerId: string | null): void {
    if (ownerId === user.id && can(user.role, Permission.ARTIFACT_READ)) return;
    if (can(user.role, Permission.ARTIFACT_READ) && can(user.role, Permission.RESERVATION_READ_ALL))
      return;
    throw new ForbiddenException();
  }

  async listForSession(user: AuthUser, sessionId: string): Promise<ArtifactDto[]> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { reservation: { select: { userId: true } } },
    });
    if (!s) throw new NotFoundException();
    this.assertCanRead(user, s.reservation.userId);
    const rows = await this.prisma.artifact.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toArtifactDto);
  }

  async listMine(user: AuthUser): Promise<ArtifactDto[]> {
    const rows = await this.prisma.artifact.findMany({
      where: { OR: [{ createdById: user.id }, { session: { reservation: { userId: user.id } } }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toArtifactDto);
  }

  /** Every download is audited (recordings and logs can contain test customer data). */
  async open(
    user: AuthUser,
    id: string,
    ip: string | null,
  ): Promise<{ stream: Readable; fileName: string; contentType: string; size: number }> {
    const { artifact, ownerId } = await this.loadWithOwner(id);
    this.assertCanRead(user, ownerId);
    const stream = await this.storage.get(artifact.storageKey);
    await this.audit.log({
      action: AuditAction.ARTIFACT_DOWNLOAD,
      userId: user.id,
      entityType: 'Artifact',
      entityId: id,
      metadata: { type: artifact.type, sessionId: artifact.sessionId },
      ip,
    });
    return {
      stream,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      size: Number(artifact.sizeBytes),
    };
  }
}
