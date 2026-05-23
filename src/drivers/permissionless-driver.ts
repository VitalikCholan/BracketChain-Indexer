import { Logger } from '@nestjs/common';
import type { SolanaSigner } from '@solana/keychain';
import { KeychainService, type KeyRole } from '../keys/keychain.service';

/**
 * Base class for BracketChain's Phase 1 permissionless crons. Consolidates the
 * concerns every signing cron shares so the four concrete drivers
 * (auto-claim, vrf-reveal, partial-refund, close-terminal — landing in Stages
 * B/D/E) stay thin and don't copy-paste guards. This is the R2 ("cron sprawl")
 * mitigation: one abstraction, config-driven enable + production guards.
 *
 * A concrete driver subclasses this, declares its name + signing role, and
 * implements `tick()`. It owns its schedule via a `@Cron` method that delegates
 * to `drive()`:
 *
 * ```ts
 * @Injectable()
 * export class AutoClaimDriver extends PermissionlessDriver {
 *   protected readonly driverName = 'auto-claim';
 *   protected readonly role: KeyRole = 'claim-payer';
 *   constructor(keychain: KeychainService) { super(keychain); }
 *
 *   @Cron(CronExpression.EVERY_MINUTE)
 *   async handle() { await this.drive(); }
 *
 *   protected async tick() {
 *     const signer = await this.signer();
 *     // scan matches past claim_deadline && !disputed → build + send claim_result
 *   }
 * }
 * ```
 */
export abstract class PermissionlessDriver {
  protected readonly logger: Logger;

  /** Kebab-case driver id — used in logs and to derive the per-driver flag. */
  protected abstract readonly driverName: string;

  /** Signing role this driver uses; resolved through {@link KeychainService}. */
  protected abstract readonly role: KeyRole;

  private running = false;

  constructor(protected readonly keychain: KeychainService) {
    this.logger = new Logger(this.constructor.name);
  }

  /**
   * The driver's unit of work: scan chain/DB for actionable state, then build,
   * sign (via {@link signer}), and submit the permissionless instruction(s).
   * Implementations should be idempotent — a tick may overlap a prior on-chain
   * effect that hasn't been indexed yet.
   */
  protected abstract tick(): Promise<void>;

  /** The signer for this driver's role. */
  protected signer(): Promise<SolanaSigner> {
    return this.keychain.getSigner(this.role);
  }

  /**
   * Guarded entrypoint. Concrete drivers call this from their own `@Cron`
   * method. Applies the production guard, prevents overlapping ticks, and
   * isolates errors so one bad tick never crashes the indexer.
   */
  protected async drive(): Promise<void> {
    if (!this.enabled()) return;
    if (this.running) {
      this.logger.warn(`${this.driverName}: previous tick still running — skipping`);
      return;
    }
    this.running = true;
    const started = Date.now();
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`${this.driverName}: tick failed — ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.logger.debug(`${this.driverName}: tick done in ${Date.now() - started}ms`);
    }
  }

  /**
   * Production guard. A driver runs only when BOTH the global kill switch and
   * its own flag are `"true"`:
   *  - `PERMISSIONLESS_DRIVERS_ENABLED` — master switch for all drivers, and
   *  - `PERMISSIONLESS_<DRIVER>_ENABLED` — e.g. `PERMISSIONLESS_AUTO_CLAIM_ENABLED`.
   *
   * Default-off: a fresh deploy never signs until explicitly enabled.
   */
  protected enabled(): boolean {
    if (process.env.PERMISSIONLESS_DRIVERS_ENABLED !== 'true') return false;
    const flag = `PERMISSIONLESS_${this.driverName.toUpperCase().replace(/-/g, '_')}_ENABLED`;
    return process.env[flag] === 'true';
  }
}
