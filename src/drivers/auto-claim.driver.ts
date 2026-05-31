import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BracketChainClient,
  claimResult,
  getTournament,
  PayoutPreset,
} from '@bracketchain/sdk';

import { MatchStatus, ProposalSource } from '../generated/prisma';
import { KeychainService, type KeyRole } from '../keys/keychain.service';
import { PrismaService } from '../prisma.service';
import { PermissionlessDriver } from './permissionless-driver';

/**
 * B-15 — auto-claim cron. The first {@link PermissionlessDriver} consumer.
 *
 * Scans the read-cache for matches whose player-reported proposal went
 * unanswered past its dispute window (`status = PendingConfirmation`,
 * `!disputed`, `claim_deadline` elapsed) and finalizes them permissionlessly
 * via `claim_result`, signed by the `claim-payer` role. The resulting on-chain
 * finalize propagates to the UI through the SDK's Solana account subscription —
 * no `Notification` is emitted (dropped in B-14 per `architect/`).
 *
 * Final-match scope (decision 2a — a design boundary, not a deferred helper):
 * only `WinnerTakesAll` finals auto-claim (placements = `[winner]`, fully
 * determined by the on-chain result). `Standard` / `Deep` finals are
 * **intentionally NOT** auto-claimed: the program validates only placements[0]
 * (winner) and [1] (runner-up) and trusts the rest, and single-elim has no
 * 3rd-place match — so 3rd place is an **organizer-adjudicated** choice among
 * the semifinal losers (frontend `ReportResultModal.buildPlacements` asks the
 * organizer to pick; "Position 3 is organizer-trusted on-chain"). A
 * permissionless cron has no basis to make that real-money decision, so such
 * finals are logged and left to the organizer/player UI. (A future
 * `computePlacements` helper could only encode an arbitrary tiebreak the
 * product deliberately leaves to a human.)
 */
@Injectable()
export class AutoClaimDriver extends PermissionlessDriver {
  protected readonly driverName = 'auto-claim';
  protected readonly role: KeyRole = 'claim-payer';

  /** Max matches finalized per tick — bounds RPC + tx load on one pass. */
  private static readonly MAX_PER_TICK = 25;

  /** Built once on first actionable tick (needs the async keychain signer). */
  private client?: BracketChainClient;

  constructor(
    keychain: KeychainService,
    private readonly prisma: PrismaService,
  ) {
    super(keychain);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    await this.drive();
  }

  protected async tick(): Promise<void> {
    const due = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.PendingConfirmation,
        disputed: false,
        proposalSource: { not: ProposalSource.None },
        claimDeadline: { lte: new Date() },
      },
      select: {
        tournamentAddress: true,
        bracket: true,
        round: true,
        matchIndex: true,
        proposedWinner: true,
      },
      orderBy: { claimDeadline: 'asc' },
      take: AutoClaimDriver.MAX_PER_TICK,
    });
    if (due.length === 0) return;

    const client = await this.getClient();
    this.logger.log(`auto-claim: ${due.length} match(es) past claim_deadline`);

    let claimed = 0;
    for (const m of due) {
      try {
        if (await this.claimOne(client, m)) claimed++;
      } catch (err) {
        // Isolate per-match: a stale row (already claimed on-chain but not yet
        // re-indexed) or a transient RPC error must not abort the rest of the
        // tick. The next tick re-evaluates from fresh cache state.
        this.logger.warn(
          `auto-claim: skip ${m.tournamentAddress} b${m.bracket}r${m.round}m${m.matchIndex} — ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`auto-claim: finalized ${claimed}/${due.length}`);
  }

  /** Finalize one match. Returns false when intentionally skipped (deferred-scope final). */
  private async claimOne(
    client: BracketChainClient,
    m: {
      tournamentAddress: string;
      bracket: number;
      round: number;
      matchIndex: number;
      proposedWinner: string | null;
    },
  ): Promise<boolean> {
    // SDK runs on its own (pnpm-linked) @solana/kit copy, so addresses cross a
    // module boundary — `as never` bridges the (structurally identical) branded
    // string types, same pattern as identity.service. Runtime values are plain
    // base58 strings.
    const tournamentPda = m.tournamentAddress as never;
    const tournament = await getTournament(client, tournamentPda);

    // isFinal mirrors the SDK's buildFinalizeContext: last round, match 0.
    const maxRound = Math.log2(tournament.bracketSize);
    const isFinal = m.round + 1 === maxRound && m.matchIndex === 0;

    let placements: never[] | undefined;
    if (isFinal) {
      if (tournament.payoutPreset !== PayoutPreset.WinnerTakesAll) {
        this.logger.log(
          `auto-claim: final ${m.tournamentAddress} preset=${PayoutPreset[tournament.payoutPreset]} ` +
            `requires an organizer-adjudicated 3rd place — finalize via the UI, not the cron (by design)`,
        );
        return false;
      }
      if (!m.proposedWinner) {
        this.logger.warn(
          `auto-claim: final ${m.tournamentAddress} has no proposedWinner in cache — skipping`,
        );
        return false;
      }
      placements = [m.proposedWinner as never];
    }

    const { txSignature, isFinal: wasFinal } = await claimResult(client, {
      tournamentPda,
      round: m.round,
      matchIndex: m.matchIndex,
      bracket: m.bracket,
      placements,
    });
    this.logger.log(
      `auto-claim: claimed ${m.tournamentAddress} b${m.bracket}r${m.round}m${m.matchIndex} ` +
        `final=${wasFinal} tx=${txSignature}`,
    );
    return true;
  }

  /** Build (and cache) the signing SDK client for the `claim-payer` role. */
  private async getClient(): Promise<BracketChainClient> {
    if (this.client) return this.client;
    const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
    const wsUrl = process.env.RPC_WS_URL ?? rpcUrl.replace(/^http/, 'ws');
    const programId = process.env.PROGRAM_ID;
    if (!programId) throw new Error('PROGRAM_ID env var is required');
    const signer = await this.signer();
    this.client = new BracketChainClient({
      rpc: rpcUrl,
      rpcSubscriptions: wsUrl,
      signer: signer as never,
      programAddress: programId as never,
      commitment: 'confirmed',
    });
    return this.client;
  }
}
