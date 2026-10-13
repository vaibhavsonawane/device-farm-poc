import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';
import { HostsService } from '../hosts/hosts.service';
import { ReservationsService } from './reservations.service';

/** Periodic housekeeping: idle/expiry/offline reservation release and stale host detection. */
@Injectable()
export class SweeperService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly reservations: ReservationsService,
    private readonly hosts: HostsService,
    @InjectEnv() private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return; // tests call tick() directly
    this.timer = setInterval(() => void this.tick(), this.env.SWEEP_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.hosts.sweepStaleHosts();
      await this.reservations.sweep();
    } catch (err) {
      this.logger.error(`sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
