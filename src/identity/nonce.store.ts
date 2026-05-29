import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

export interface NonceEntry {
  wallet: string;
  returnTo: string;
  createdAt: number;
}

/** Nonce lifetime — a login round-trip (sign → Steam → callback) is seconds. */
const TTL_MS = 5 * 60 * 1000;
/** How often stale entries are swept. */
const SWEEP_MS = 60 * 1000;

/**
 * Short-lived single-use nonce store for the Steam-link flow (A11-4).
 *
 * `/identity/steam/login` puts `{ wallet, returnTo }` under a fresh nonce; the
 * Steam callback `consume()`s it. Two invariants back the A-11 replay defence:
 *
 *  - **Single-use:** `consume()` deletes on first read, so replaying the
 *    callback URL finds nothing (→ 404/redirect-with-error).
 *  - **TTL:** entries older than 5 min are evicted by the sweep (and treated as
 *    absent on lookup), so a login left open then walked away from goes stale.
 *
 * In-memory is sufficient for Phase 1 (single production indexer instance);
 * swap for Redis if the indexer is ever horizontally scaled.
 */
@Injectable()
export class NonceStore implements OnModuleDestroy {
  private readonly logger = new Logger(NonceStore.name);
  private readonly map = new Map<string, NonceEntry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    // Don't keep the event loop alive solely for the sweep.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /** Store a fresh nonce. Overwrites any prior entry for the same nonce. */
  put(nonce: string, entry: Omit<NonceEntry, 'createdAt'>): void {
    this.map.set(nonce, { ...entry, createdAt: Date.now() });
  }

  /**
   * Single-use lookup: returns the entry and removes it. Returns null if the
   * nonce is unknown or already expired (stale entries never resolve).
   */
  consume(nonce: string): NonceEntry | null {
    const entry = this.map.get(nonce);
    if (!entry) return null;
    this.map.delete(nonce);
    if (Date.now() - entry.createdAt > TTL_MS) return null;
    return entry;
  }

  /** Evict expired entries. Runs on the interval; exposed for tests. */
  sweep(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [nonce, entry] of this.map) {
      if (now - entry.createdAt > TTL_MS) {
        this.map.delete(nonce);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.debug(`swept ${evicted} expired nonce(s)`);
    }
  }

  /** Current entry count — for tests/health. */
  get size(): number {
    return this.map.size;
  }
}
