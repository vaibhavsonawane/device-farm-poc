import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuditLogDto, Permission } from '@devicelab/shared-types';
import { type Response } from 'express';
import { z } from 'zod';
import { Permissions } from '../common/auth.decorators';
import { ApiZodQuery, ZodPipe } from '../common/zod';
import { AuditService } from './audit.service';

const auditQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  action: z.string().max(64).optional(),
  entityType: z.string().max(32).optional(),
  entityId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Quote everything; neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Permissions(Permission.AUDIT_READ)
  @ApiZodQuery(auditQuerySchema)
  async list(@Query(new ZodPipe(auditQuerySchema)) q: z.infer<typeof auditQuerySchema>) {
    const { items, total } = await this.audit.list(q);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get('export.csv')
  @Permissions(Permission.AUDIT_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="devicelab-audit.csv"')
  async exportCsv(
    @Query(
      new ZodPipe(
        auditQuerySchema.extend({
          pageSize: z.coerce.number().int().min(1).max(50_000).default(10_000),
        }),
      ),
    )
    q: z.infer<typeof auditQuerySchema>,
    @Res() res: Response,
  ): Promise<void> {
    const { items } = await this.audit.list({ ...q, page: 1 });
    const cols: (keyof AuditLogDto)[] = [
      'createdAt',
      'userName',
      'userId',
      'action',
      'entityType',
      'entityId',
      'ip',
      'metadata',
    ];
    const lines = [cols.join(','), ...items.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
    res.send(lines.join('\n'));
  }
}
