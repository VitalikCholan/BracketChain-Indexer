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

  /**
   * L-1: in-flight dedup. Maps an item key (e.g. a match coordinate) to the
   * epoch-ms after which it may be acted on again. After a driver submits a tx
   * for an item it calls {@link markActed}; the next tick (≈60s later) skips
   * that item via {@link recentlyActed} until the on-chain effect has had time
   * to re-index, so we don't fire a second redundant tx into the dispute/claim
   * window. Pure optimization — the on-chain program already rejects a true
   * duplicate; this just avoids the wasted tx + fee. Process-local (single
   * instance, no replicas) and lost on restart, which is fine: a restart at
   * worst re-sends one tx the chain rejects.
   */
  private readonly inFlight = new Map<string, number>();

  /**
   * Grace window for {@link inFlight}. Slightly longer than the 60s cron
   * cadence so an item acted on in tick N is suppressed in tick N+1 but
   * eligible again by tick N+2 if still genuinely due (re-index never landed).
   */
  protected static readonly IN_FLIGHT_GRACE_MS = 90_000;

  constructor(protected readonly keychain: KeychainService) {
    this.logger = new Logger(this.constructor.name);
  }

  /**
   * True if `key` was acted on within the grace window — the caller should skip
   * it this tick. Expired entries are pruned lazily on read.
   */
  protected recentlyActed(key: string): boolean {
    const until = this.inFlight.get(key);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.inFlight.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Record that a tx was submitted for `key`, suppressing re-selection for
   * {@link IN_FLIGHT_GRACE_MS}. Opportunistically GCs expired entries so the
   * map can't grow unbounded across long uptimes.
   */
  protected markActed(key: string): void {
    this.inFlight.set(
      key,
      Date.now() + PermissionlessDriver.IN_FLIGHT_GRACE_MS,
    );
    if (this.inFlight.size > 1000) {
      const now = Date.now();
      for (const [k, until] of this.inFlight) {
        if (now > until) this.inFlight.delete(k);
      }
    }
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
      this.logger.warn(
        `${this.driverName}: previous tick still running — skipping`,
      );
      return;
    }
    this.running = true;
    const started = Date.now();
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(
        `${this.driverName}: tick failed — ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
      this.logger.debug(
        `${this.driverName}: tick done in ${Date.now() - started}ms`,
      );
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
