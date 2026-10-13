import { Global, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { type Env } from '../config/env';
import { InjectEnv } from '../config/config.module';

// Compare-and-delete: only remove a lock if we still own it.
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

// Compare-and-extend.
const EXTEND_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@InjectEnv() env: Env) {
    this.client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.client.on('error', (err) => this.logger.warn(`redis: ${err.message}`));
  }

  /** SET NX PX. Returns true if the lock was acquired. */
  async acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.set(key, owner, 'PX', Math.max(1000, Math.round(ttlMs)), 'NX');
    return res === 'OK';
  }

  async releaseLock(key: string, owner: string): Promise<boolean> {
    const res = await this.client.eval(RELEASE_LOCK, 1, key, owner);
    return res === 1;
  }

  async extendLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.eval(EXTEND_LOCK, 1, key, owner, String(Math.round(ttlMs)));
    return res === 1;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
