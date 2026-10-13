/**
 * Idempotent seed: admin user, a team, BFSI demo projects and (optionally) demo
 * users plus a mock host for local development.
 *
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD  — admin credentials (password generated if unset)
 *   SEED_DEMO=true                          — also create lead/tester/viewer demo users
 *   SEED_MOCK_HOST_TOKEN=dlh_...            — register "mock-host-01" with this agent token
 */
import { PrismaClient, type Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { sha256Hex } from '../common/crypto';

const prisma = new PrismaClient();

async function upsertUser(
  email: string,
  name: string,
  role: Role,
  password: string,
  teamId: string,
): Promise<boolean> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return false;
  await prisma.user.create({
    data: { email, name, role, teamId, passwordHash: await hashPassword(password) },
  });
  return true;
}

async function main(): Promise<void> {
  const team = await prisma.team.upsert({
    where: { name: 'QA Core' },
    update: {},
    create: { name: 'QA Core' },
  });
  for (const p of [
    { name: 'USFB Mobile Banking', code: 'USFB' },
    { name: 'Tata Capital Lending', code: 'TATACAP' },
    { name: 'Merchant App', code: 'MERCHANT' },
  ]) {
    await prisma.project.upsert({
      where: { code: p.code },
      update: {},
      create: { ...p, teamId: team.id },
    });
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@devicelab.local').toLowerCase();
  const generated = !process.env.SEED_ADMIN_PASSWORD;
  const adminPassword =
    process.env.SEED_ADMIN_PASSWORD ?? `Dl-${randomBytes(9).toString('base64url')}9a`;
  if (await upsertUser(adminEmail, 'Lab Admin', 'ADMIN', adminPassword, team.id)) {
    console.log(
      `✔ admin created: ${adminEmail}${generated ? `  password: ${adminPassword}  (change it after first login)` : ''}`,
    );
  } else {
    console.log(`• admin ${adminEmail} already exists`);
  }

  if (process.env.SEED_DEMO === 'true') {
    const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'DeviceLab@2026';
    for (const [email, name, role] of [
      ['lead@devicelab.local', 'Priya Lead', 'LEAD'],
      ['tester@devicelab.local', 'Arjun Tester', 'TESTER'],
      ['tester2@devicelab.local', 'Meera Tester', 'TESTER'],
      ['viewer@devicelab.local', 'Ravi Viewer', 'VIEWER'],
    ] as const) {
      if (await upsertUser(email, name, role, demoPassword, team.id))
        console.log(`✔ demo ${role.toLowerCase()}: ${email} / ${demoPassword}`);
    }
  }

  const mockToken = process.env.SEED_MOCK_HOST_TOKEN;
  if (mockToken) {
    if (!/^dlh_[A-Za-z0-9_-]{20,}$/.test(mockToken))
      throw new Error('SEED_MOCK_HOST_TOKEN must look like dlh_<random>');
    await prisma.host.upsert({
      where: { name: 'mock-host-01' },
      update: { tokenHash: sha256Hex(mockToken), tokenRevokedAt: null },
      create: { name: 'mock-host-01', tokenHash: sha256Hex(mockToken) },
    });
    console.log('✔ host mock-host-01 registered with SEED_MOCK_HOST_TOKEN');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
