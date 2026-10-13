// Environment for API integration tests. Needs Postgres + Redis (docker compose or local).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://devicelab:devicelab@localhost:5432/devicelab_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_STREAM_SECRET = 'test-stream-secret-0123456789abcdef0123456789';
process.env.STORAGE_DRIVER = 'fs';
process.env.STORAGE_DIR = './storage-test';
process.env.CORS_ORIGINS = '';
