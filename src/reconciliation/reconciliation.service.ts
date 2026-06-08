import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PublicKey } from '@solana/web3.js';

import { PrismaService } from '../prisma.service';
import {
  ChainReaderService,
  type DecodedTournament,
} from '../chain/chain-reader.service';
import {
  Game,
  MatchStatus,
  PayoutPreset,
  SettlementMode,
  TournamentStatus,
} from '../generated/prisma';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  // Health-endpoint visibility. Updated on every cron tick.
  private lastReconcileAt: Date | null = null;
  private lastReconcileTouched = 0;
  private lastReconcileError: string | null = null;
  private lastReconcileScanned = 0;
  private lastReconcilePayoutsBackfilled = 0;
  private lastReconcileFreshnessBumped = 0;
  private lastStuckFinals: string[] = [];

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
      this.lastReconcilePayoutsBackfilled = stats.payoutsBackfilled;
      this.lastReconcileFreshnessBumped = stats.freshnessBumped;
      this.lastReconcileError = null;
      if (stats.touched > 0 || stats.payoutsBackfilled > 0) {
        this.logger.log(
          `Reconciliation: scanned=${stats.scanned}, touched=${stats.touched}, ` +
            `payoutsBackfilled=${stats.payoutsBackfilled}`,
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
      lastReconcilePayoutsBackfilled: this.lastReconcilePayoutsBackfilled,
      lastReconcileFreshnessBumped: this.lastReconcileFreshnessBumped,
      lastReconcileError: this.lastReconcileError,
      stuckFinalsCount: this.lastStuckFinals.length,
      stuckFinals: this.lastStuckFinals,
    };
  }

  // ── implementation ─────────────────────────────────────────────────────────

  private async runReconciliation(): Promise<{
    scanned: number;
    touched: number;
    payoutsBackfilled: number;
    freshnessBumped: number;
  }> {
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
        settlementMode: true,
        game: true,
        completedAt: true,
        completedTxSig: true,
      },
    });

    if (candidates.length === 0) {
      return {
        scanned: 0,
        touched: 0,
        payoutsBackfilled: 0,
        freshnessBumped: 0,
      };
    }

    // Batch fetch — one getMultipleAccountsInfo for up to 50 PDAs.
    const pdas = candidates.map((c) => new PublicKey(c.address));
    const [chainAccounts, currentSlot] = await Promise.all([
      this.chainReader.fetchTournaments(pdas),
      this.chainReader.getSlot(),
    ]);

    const slot = BigInt(currentSlot);
    let touched = 0;
    // M-4: addresses whose only change is the freshness watermark. Collected
    // and flushed in ONE batched updateMany after the loop, instead of up to 50
    // individual per-row UPDATEs (write-amplification). The watermark value is
    // identical for all of them (the current slot), so a bulk set is exact.
    const freshIds: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const dbRow = candidates[i];
      const chain = chainAccounts[i];
      if (!chain) continue; // account missing or decode failed — skip

      const chainStatus = anchorEnumToDbStatus(chain.status);
      const chainChampion = chain.champion.equals(PublicKey.default)
        ? null
        : chain.champion.toBase58();

      const statusDrift = chainStatus !== null && chainStatus !== dbRow.status;
      const championDrift = chainChampion !== dbRow.champion;
      const slotDrift = dbRow.chainSlotAtWrite < slot - BigInt(150);
      // settlement_mode is immutable on-chain and carried by no event, so we
      // backfill it set-once: populate the cache the first time we see the row.
      const chainSettlement = anchorEnumToSettlementMode(chain.settlement_mode);
      const needsSettlement =
        dbRow.settlementMode === null && chainSettlement !== null;
      // game is immutable on-chain and carried by no event — backfill set-once,
      // same as settlement_mode.
      const chainGame = anchorEnumToGame(chain.game);
      const needsGame = dbRow.game === null && chainGame !== null;

      // M-4: split content-drift from a freshness-only watermark touch. A row
      // with no real drift but a stale watermark does NOT need a full-row
      // update — it is batched into a single updateMany after the loop. Only
      // genuine drift (status/champion/settlement/game) takes the per-row write
      // and counts toward `touched`.
      const contentDrift =
        statusDrift || championDrift || needsSettlement || needsGame;
      if (!contentDrift && !slotDrift) {
        continue; // fully verified, nothing to write
      }
      if (!contentDrift) {
        freshIds.push(dbRow.address); // freshness-only → batched bump below
        continue;
      }

      // Content drift: mutate only the fields that drifted. Bump
      // chainSlotAtWrite too — this row is freshly verified as of `slot`.
      const data: {
        status?: TournamentStatus;
        champion?: string | null;
        settlementMode?: SettlementMode;
        game?: Game;
        completedAt?: Date;
        chainSlotAtWrite: bigint;
      } = { chainSlotAtWrite: slot };

      if (statusDrift && chainStatus !== null) {
        data.status = chainStatus;
        this.logger.warn(
          `Drift: ${dbRow.address} status DB=${dbRow.status} → chain=${chainStatus}`,
        );
      }

      // M-1: when reconciliation is the one moving a row into a terminal state
      // (dropped Completed/Cancelled webhook) and completedAt is still unset,
      // stamp it — otherwise the close-terminal rent-reclaim cron, which gates
      // on `completedAt <= cutoff`, would never pick the row up.
      const becomesTerminal =
        statusDrift &&
        (chainStatus === TournamentStatus.Completed ||
          chainStatus === TournamentStatus.Cancelled);
      if (becomesTerminal && dbRow.completedAt == null) {
        const chainCompletedSec = Number(chain.completed_at.toString());
        data.completedAt =
          chainCompletedSec > 0
            ? new Date(chainCompletedSec * 1000)
            : new Date();
      }
      if (championDrift) {
        data.champion = chainChampion;
      }
      if (needsSettlement && chainSettlement !== null) {
        data.settlementMode = chainSettlement;
      }
      if (needsGame && chainGame !== null) {
        data.game = chainGame;
      }

      await this.prisma.tournament.update({
        where: { address: dbRow.address },
        data,
      });
      touched++;
    }

    // M-4: flush all freshness-only watermark bumps in one statement. Preserves
    // the SWR freshness contract (frontend `useTournamentView` gates on
    // `currentSlot - chainSlotAtWrite` vs STALE_SLOT_THRESHOLD) without N
    // per-row UPDATEs. Kept out of `touched` (it is not drift).
    let freshnessBumped = 0;
    if (freshIds.length > 0) {
      const bumped = await this.prisma.tournament.updateMany({
        where: { address: { in: freshIds } },
        data: { chainSlotAtWrite: slot },
      });
      freshnessBumped = bumped.count;
    }

    const payoutsBackfilled = await this.backfillMissingPayouts(
      candidates,
      chainAccounts,
    );


    try {
      this.lastStuckFinals = await this.detectStuckFinals();
    } catch (err) {
      this.logger.warn(
        `Stuck-final sweep failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      scanned: candidates.length,
      touched,
      payoutsBackfilled,
      freshnessBumped,
    };
  }

  private async detectStuckFinals(): Promise<string[]> {
    const now = new Date();

    const candidates = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.PendingConfirmation,
        disputed: false,
        matchIndex: 0,
        claimDeadline: { not: null, lte: now },
        tournament: {
          status: TournamentStatus.Active,
          payoutPreset: { not: PayoutPreset.WinnerTakesAll },
        },
      },
      select: {
        tournamentAddress: true,
        bracket: true,
        round: true,
        matchIndex: true,
      },
    });
    if (candidates.length === 0) return [];

    const maxRounds = await this.prisma.match.groupBy({
      by: ['tournamentAddress'],
      where: {
        tournamentAddress: {
          in: candidates.map((c) => c.tournamentAddress),
        },
      },
      _max: { round: true },
    });
    const maxByTournament = new Map(
      maxRounds.map((r) => [r.tournamentAddress, r._max.round]),
    );

    const stuck = candidates.filter(
      (c) => c.round === maxByTournament.get(c.tournamentAddress),
    );
    for (const s of stuck) {
      this.logger.warn(
        `Stuck non-WTA final: ${s.tournamentAddress} b${s.bracket}r${s.round}m${s.matchIndex} ` +
          `— undisputed past the claim deadline; awaiting arbitrator settle_final (finalize via the UI)`,
      );
    }
    return stuck.map(
      (s) => `${s.tournamentAddress}:${s.bracket}:${s.round}:${s.matchIndex}`,
    );
  }

  /**
   * M-2: reconstruct Payout rows for Completed tournaments whose Payout table
   * is empty — the symptom of a dropped `TournamentCompleted` webhook (status
   * gets backfilled above, but payouts only ever came from that event). The
   * per-placement breakdown lives only in the event, so {@link ChainReaderService}
   * replays the completion tx from chain. Each reconstruction is isolated: a
   * failure to rebuild one tournament's payouts never aborts the cron tick.
   */
  private async backfillMissingPayouts(
    candidates: Array<{
      address: string;
      status: TournamentStatus;
      completedTxSig: string | null;
    }>,
    chainAccounts: Array<DecodedTournament | null>,
  ): Promise<number> {
    // A tournament is in scope if it is Completed by either the DB or chain.
    const completed: Array<{ address: string; completedTxSig: string | null }> =
      [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const chain = chainAccounts[i];
      const chainStatus = chain ? anchorEnumToDbStatus(chain.status) : null;
      if (
        chainStatus === TournamentStatus.Completed ||
        c.status === TournamentStatus.Completed
      ) {
        completed.push({
          address: c.address,
          completedTxSig: c.completedTxSig,
        });
      }
    }
    if (completed.length === 0) return 0;

    // Which of those already have payout rows? One query, then set-difference.
    const existing = await this.prisma.payout.findMany({
      where: { tournamentAddress: { in: completed.map((c) => c.address) } },
      select: { tournamentAddress: true },
      distinct: ['tournamentAddress'],
    });
    const hasPayout = new Set(existing.map((e) => e.tournamentAddress));
    const missing = completed.filter((c) => !hasPayout.has(c.address));
    if (missing.length === 0) return 0;

    let backfilled = 0;
    for (const m of missing) {
      try {
        const result = await this.chainReader.fetchCompletionPayouts(
          new PublicKey(m.address),
          m.completedTxSig,
        );
        if (!result) {
          this.logger.warn(
            `Payout backfill: ${m.address} — no reconstructable completion event, skipping`,
          );
          continue;
        }
        // skipDuplicates keeps this idempotent against a late webhook arriving
        // concurrently (same (txSignature, recipient, kind) unique index).
        const created = await this.prisma.payout.createMany({
          data: result.payouts.map((p) => ({
            tournamentAddress: m.address,
            recipient: p.recipient,
            amount: p.amount,
            kind: p.kind,
            placement: p.placement,
            txSignature: result.txSignature,
          })),
          skipDuplicates: true,
        });
        if (created.count > 0) {
          backfilled++;
          this.logger.log(
            `Payout backfill: ${m.address} → inserted ${created.count} rows (tx=${result.txSignature})`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Payout backfill: ${m.address} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return backfilled;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Anchor 0.32+ with new IDL format decodes enum variants as PascalCase.
const ENUM_TO_STATUS: Record<string, TournamentStatus> = {
  Registration: TournamentStatus.Registration,
  PendingBracketInit: TournamentStatus.PendingBracketInit,
  Active: TournamentStatus.Active,
  Completed: TournamentStatus.Completed,
  Cancelled: TournamentStatus.Cancelled,
  PartialCancelled: TournamentStatus.PartialCancelled,
};

function anchorEnumToDbStatus(variant: {
  [k: string]: object;
}): TournamentStatus | null {
  const keys = Object.keys(variant);
  if (keys.length !== 1) return null;
  return ENUM_TO_STATUS[keys[0]] ?? null;
}

const ENUM_TO_SETTLEMENT: Record<string, SettlementMode> = {
  OrganizerOnly: SettlementMode.OrganizerOnly,
  PlayerReported: SettlementMode.PlayerReported,
  Oracle: SettlementMode.Oracle,
};

function anchorEnumToSettlementMode(variant: {
  [k: string]: object;
}): SettlementMode | null {
  const keys = Object.keys(variant);
  if (keys.length !== 1) return null;
  return ENUM_TO_SETTLEMENT[keys[0]] ?? null;
}

const ENUM_TO_GAME: Record<string, Game> = {
  Manual: Game.Manual,
  Dota2: Game.Dota2,
  Cs2Faceit: Game.Cs2Faceit,
  Valorant: Game.Valorant,
  LoL: Game.LoL,
};

function anchorEnumToGame(variant: { [k: string]: object }): Game | null {
  const keys = Object.keys(variant);
  if (keys.length !== 1) return null;
  return ENUM_TO_GAME[keys[0]] ?? null;
}

// Unused but kept exported for symmetry with handler — Phase 5.5 may want
// preset reconciliation if program-side preset can change (currently it can't
// — preset is set at create_tournament and immutable).
export const ENUM_TO_PRESET: Record<string, PayoutPreset> = {
  winnerTakesAll: PayoutPreset.WinnerTakesAll,
  standard: PayoutPreset.Standard,
  deep: PayoutPreset.Deep,
};
