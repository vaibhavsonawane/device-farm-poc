// Local development convenience: load apps/server/.env if present (Docker passes real env vars).
// Imported first by main.ts so modules that read env at import time see it.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file */
}
