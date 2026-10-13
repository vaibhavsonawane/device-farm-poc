import { execSync } from 'node:child_process';
import path from 'node:path';

/** Apply pending migrations (non-destructive) to the test database once before the suite. */
export default function setup(): void {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://devicelab:devicelab@localhost:5432/devicelab_test?schema=public';
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}
