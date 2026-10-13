import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Development token seeded by `pnpm db:seed` (SEED_MOCK_HOST_TOKEN in apps/server/.env.example). */
export const DEV_MOCK_TOKEN = 'dlh_dev_mock_host_token_change_me_000000';

export const agentConfigSchema = z.object({
  /** Control server origin, e.g. https://devicelab.bank.local */
  serverUrl: z.string().url(),
  /** Per-host token from Admin → Hosts → Register host. */
  agentToken: z.string().min(20),
  hostName: z.string().min(1).max(64).default(os.hostname()),
  adbPath: z.string().default('adb'),
  adbHost: z.string().default('127.0.0.1'),
  adbPort: z.number().int().default(5037),
  /** Path to scrcpy-server (v3.3.1). `pnpm fetch:scrcpy` downloads it to vendor/. */
  scrcpyServerPath: z
    .string()
    .default(path.resolve(__dirname, '..', 'vendor', 'scrcpy-server-v3.3.1')),
  /** Optional MediaCodec hints passed to scrcpy (e.g. "latency:int=0"). */
  scrcpyCodecOptions: z
    .string()
    .regex(/^[a-zA-Z0-9_:=,.-]*$/, 'letters, digits and :=,._- only')
    .optional(),
  goIosPath: z.string().default('ios'),
  wdaBundleId: z.string().default('com.facebook.WebDriverAgentRunner.xctrunner'),
  appiumPortRange: z.tuple([z.number().int(), z.number().int()]).default([4723, 4799]),
  /** If non-empty, only these serials/UDIDs are exposed. */
  allowedSerials: z.array(z.string()).default([]),
  healthPort: z.number().int().default(4100),
  /** Extra CA certificate (PEM) for an internal PKI. NODE_EXTRA_CA_CERTS also works. */
  caFile: z.string().optional(),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type AgentConfig = z.infer<typeof agentConfigSchema> & { mock: boolean; ca?: Buffer };

export interface CliArgs {
  mock: boolean;
  configPath: string | null;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false, configPath: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--config' || a === '-c') args.configPath = argv[++i] ?? null;
    else if (a?.startsWith('--config=')) args.configPath = a.slice('--config='.length);
  }
  return args;
}

export function loadConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const file =
    args.configPath ??
    env.DEVICELAB_AGENT_CONFIG ??
    path.resolve(process.cwd(), 'agent.config.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } else if (args.configPath) {
    throw new Error(`config file not found: ${file}`);
  }
  if (env.DEVICELAB_SERVER_URL) raw.serverUrl = env.DEVICELAB_SERVER_URL;
  if (env.DEVICELAB_AGENT_TOKEN) raw.agentToken = env.DEVICELAB_AGENT_TOKEN;
  if (env.DEVICELAB_HOST_NAME) raw.hostName = env.DEVICELAB_HOST_NAME;
  if (args.mock) {
    raw.serverUrl ??= 'http://localhost:3000';
    raw.agentToken ??= DEV_MOCK_TOKEN;
    raw.hostName ??= 'mock-host-01';
  }
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid agent config (${file}):\n${issues}`);
  }
  const cfg: AgentConfig = { ...parsed.data, mock: args.mock };
  if (cfg.caFile) cfg.ca = readFileSync(cfg.caFile);
  return cfg;
}
