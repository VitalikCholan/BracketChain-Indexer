import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PublicKey } from '@solana/web3.js';

import { PrismaService } from '../prisma.service';
import { ChainReaderService } from '../chain/chain-reader.service';
import {
  PayoutPreset,
  TournamentStatus,
} from '../generated/prisma';

/**
 * Phase 5.4: reconciliation cron.
 *
 * Runs every minute, scans non-terminal tournaments + recently-completed ones,
 * batch-fetches their on-chain accounts, and patches the DB if any drift is
 * found. Catches missed webhook deliveries (TournamentStarted, TournamentCancelled,
 * TournamentCompleted, MatchReported) without requiring a separate replay path.
 *
 * Why this exists: the lean indexer (locked decision 2026-05-01) explicitly
 * cut the reconciliation cron, on the bet that Helius webhooks are reliable.
 * P6-4 surfaced webhook drops in production. Spec §6.3 promises "<5s sync
 * latency" — this cron is the retry mechanism that makes that claim survive
 * single-webhook drops without manual SQL surgery.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  // Health-endpoint visibility. Updated on every cron tick.
  private lastReconcileAt: Date | null = null;
  private lastReconcileTouched = 0;
  private lastReconcileError: string | null = null;
  private lastReconcileScanned = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chainReader: ChainReaderService,
  ) {}

  /**
   * Cron schedule: every 60 seconds. Tracks Spec §6.3 "<5s sync latency"
   * promise — webhook hits that latency on the happy path; this retry
   * loop catches drops within ~60 s, well within the SWR freshness gate
   * threshold (~150 slots ≈ 60 s) so stale UI never persists past one cron
   * tick + frontend reconcile.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    try {
      const stats = await this.runReconciliation();
      this.lastReconcileAt = new Date();
      this.lastReconcileTouched = stats.touched;
      this.lastReconcileScanned = stats.scanned;
      this.lastReconcileError = null;
      if (stats.touched > 0) {
        this.logger.log(
          `Reconciliation: scanned=${stats.scanned}, touched=${stats.touched}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastReconcileError = msg;
      this.logger.error(`Reconciliation failed: ${msg}`);
    }
  }

  /**
   * Health/diagnostic snapshot — surfaced on /health for ops visibility.
   */
  getStatus() {
    return {
      lastReconcileAt: this.lastReconcileAt?.toISOString() ?? null,
      lastReconcileScanned: this.lastReconcileScanned,
      lastReconcileTouched: this.lastReconcileTouched,
      lastReconcileError: this.lastReconcileError,
    };
  }

  // ── implementation ─────────────────────────────────────────────────────────

  private async runReconciliation(): Promise<{ scanned: number; touched: number }> {
    // Scope: every non-terminal tournament + completed/cancelled within the
    // last hour (catches late-arriving Cancelled webhook). We bound at 50
    // rows per pass to keep a single getMultipleAccountsInfo within the
    // 100-pubkey RPC cap and per-cron CPU budget.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const candidates = await this.prisma.tournament.findMany({
      where: {
        OR: [
          { status: TournamentStatus.Registration },
          { status: TournamentStatus.PendingBracketInit },
          { status: TournamentStatus.Active },
          {
            AND: [
              {
                status: {
                  in: [TournamentStatus.Completed, TournamentStatus.Cancelled],
                },
              },
              { completedAt: { gte: oneHourAgo } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        address: true,
        status: true,
        champion: true,
        chainSlotAtWrite: true,
      },
    });

    if (candidates.length === 0) {
      return { scanned: 0, touched: 0 };
    }

    // Batch fetch — one getMultipleAccountsInfo for up to 50 PDAs.
    const pdas = candidates.map((c) => new PublicKey(c.address));
    const [chainAccounts, currentSlot] = await Promise.all([
      this.chainReader.fetchTournaments(pdas),
      this.chainReader.getSlot(),
    ]);

    const slot = BigInt(currentSlot);
    let touched = 0;

    for (let i = 0; i < candidates.length; i++) {
      const dbRow = candidates[i]!;
      const chain = chainAccounts[i];
      if (!chain) continue;  // account missing or decode failed — skip

      const chainStatus = anchorEnumToDbStatus(chain.status);
      const chainChampion = chain.champion.equals(PublicKey.default)
        ? null
        : chain.champion.toBase58();

      const statusDrift = chainStatus !== null && chainStatus !== dbRow.status;
      const championDrift = chainChampion !== dbRow.champion;
      const slotDrift = dbRow.chainSlotAtWrite < slot - BigInt(150);

      if (!statusDrift && !championDrift && !slotDrift) {
        continue;
      }

      // Only mutate fields that drifted. Bump chainSlotAtWrite regardless to
      // mark the row as freshly verified.
      const data: {
        status?: TournamentStatus;
        champion?: string | null;
        chainSlotAtWrite: bigint;
      } = { chainSlotAtWrite: slot };

      if (statusDrift && chainStatus !== null) {
        data.status = chainStatus;
        this.logger.warn(
          `Drift: ${dbRow.address} status DB=${dbRow.status} → chain=${chainStatus}`,
        );
      }
      if (championDrift) {
        data.champion = chainChampion;
      }

      await this.prisma.tournament.update({
        where: { address: dbRow.address },
        data,
      });
      touched++;
    }

    return { scanned: candidates.length, touched };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const ENUM_TO_STATUS: Record<string, TournamentStatus> = {
  registration: TournamentStatus.Registration,
  pendingBracketInit: TournamentStatus.PendingBracketInit,
  active: TournamentStatus.Active,
  completed: TournamentStatus.Completed,
  cancelled: TournamentStatus.Cancelled,
};

function anchorEnumToDbStatus(
  variant: { [k: string]: object },
): TournamentStatus | null {
  const keys = Object.keys(variant);
  if (keys.length !== 1) return null;
  return ENUM_TO_STATUS[keys[0]!] ?? null;
}

// Unused but kept exported for symmetry with handler — Phase 5.5 may want
// preset reconciliation if program-side preset can change (currently it can't
// — preset is set at create_tournament and immutable).
export const ENUM_TO_PRESET: Record<string, PayoutPreset> = {
  winnerTakesAll: PayoutPreset.WinnerTakesAll,
  standard: PayoutPreset.Standard,
  deep: PayoutPreset.Deep,
};
