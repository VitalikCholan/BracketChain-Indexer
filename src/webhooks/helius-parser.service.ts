import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { PrismaService } from '../prisma.service';
import {
  MatchStatus,
  PayoutKind,
  PayoutPreset,
  Prisma,
  ProposalSource,
  TournamentStatus,
} from '../generated/prisma';
import type {
  HeliusTokenTransfer,
  HeliusTransaction,
  HeliusWebhookBody,
} from './dto/helius-payload.dto';
import type {
  BracketChainEvent,
  DisputeResolvedEvent,
  MatchFeedBoundEvent,
  MatchLobbyCommittedEvent,
  MatchReportedEvent,
  ParticipantRegisteredEvent,
  RefundIssuedEvent,
  ResultClaimedEvent,
  ResultDisputedEvent,
  ResultProposedEvent,
  TournamentCancelledEvent,
  TournamentCompletedEvent,
  TournamentCreatedEvent,
  TournamentStartedEvent,
} from './event-types';

import idlJson from '../idl/bracket_chain.json';

interface ParsedAnchorEvent {
  name: string;
  data: Record<string, unknown>;
}

/// Subset of Match columns the Stage B settlement handlers write. Spread into
/// both the create and update branch of the envelope upsert. Stage C extends
/// it with the commit/feed-bind fields written by the `MatchLobbyCommitted`
/// and `MatchFeedBound` handlers.
interface MatchEnvelopeFields {
  proposalSource?: ProposalSource;
  proposer?: string;
  proposedWinner?: string;
  proposedAt?: Date;
  claimDeadline?: Date;
  disputed?: boolean;
  disputeReason?: number;
  winner?: string;
  reportedAt?: Date;
  reportedTxSig?: string;
  lobbyId?: Uint8Array<ArrayBuffer>;
  committedAt?: Date;
  switchboardFeed?: string;
}

const PAYOUT_PRESET_BY_INDEX: Record<number, PayoutPreset> = {
  0: PayoutPreset.WinnerTakesAll,
  1: PayoutPreset.Standard,
  2: PayoutPreset.Deep,
};

/// On-chain `ProposalSource` discriminant → Prisma enum. None=0 never appears
/// in a ResultProposed event (a live proposal is always Player/Oracle/…), but
/// the map is total for safety.
const PROPOSAL_SOURCE_BY_INDEX: Record<number, ProposalSource> = {
  0: ProposalSource.None,
  1: ProposalSource.Player,
  2: ProposalSource.Oracle,
  3: ProposalSource.GameServer,
};

@Injectable()
export class HeliusParserService implements OnModuleInit {
  private readonly logger = new Logger(HeliusParserService.name);
  private parser!: EventParser;
  private programId!: PublicKey;
  /// Optional mint filter for tokenTransfers — set via TOKEN_MINT_FILTER env
  /// (legacy: USDC_MINT). Skip transfers in other mints when narrowing the
  /// indexer to a single token. Leave unset for multi-token indexing.
  private tokenMintFilter: string | null = null;
  /// Events are stamped with `event_version` as their first field (program
  /// constant `EVENT_VERSION_V1`). The parser rejects any other version to
  /// prevent silent Borsh mis-decode after a future event-layout change (C10).
  private static readonly EVENT_VERSION_V1 = 1;
  /// Count of events skipped for a mismatched `event_version` — surfaced at
  /// `/health` as `eventVersion.unknownCount` (R1 silent-drift guard metric).
  private unknownEventVersionCount = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Number of events rejected so far for an unrecognized `event_version`. */
  getUnknownEventVersionCount(): number {
    return this.unknownEventVersionCount;
  }

  onModuleInit() {
    const programIdStr = process.env.PROGRAM_ID;
    if (!programIdStr) {
      throw new Error('PROGRAM_ID env var is required');
    }
    this.programId = new PublicKey(programIdStr);
    const coder = new BorshCoder(idlJson as Idl);
    this.parser = new EventParser(this.programId, coder);
    // Back-compat: fall back to legacy USDC_MINT env if TOKEN_MINT_FILTER unset.
    this.tokenMintFilter =
      process.env.TOKEN_MINT_FILTER ?? process.env.USDC_MINT ?? null;
    this.logger.log(
      `Initialized parser for program ${this.programId.toBase58()}`,
    );
  }

  async processBatch(
    body: HeliusWebhookBody,
  ): Promise<{ processed: number; events: number }> {
    let eventCount = 0;
    for (const tx of body) {
      try {
        eventCount += await this.processTransaction(tx);
      } catch (err) {
        this.logger.error(
          `Failed to process tx ${tx.signature ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { processed: body.length, events: eventCount };
  }

  private async processTransaction(tx: HeliusTransaction): Promise<number> {
    if (tx.transactionError || tx.meta?.err) {
      return 0;
    }
    const signature = extractSignature(tx);
    if (!signature) {
      this.logger.warn('Skipping tx without signature');
      return 0;
    }

    const logs = extractLogs(tx);
    if (!logs || logs.length === 0) {
      return 0;
    }

    const rawEvents = Array.from(
      this.parser.parseLogs(logs),
    ) as ParsedAnchorEvent[];
    if (rawEvents.length === 0) return 0;

    // Cast to the discriminated union so the per-case `switch` narrows
    // `evt.data` to the matching event shape. BorshCoder enforces the field
    // layout via the IDL — unknown event names fall through to the default
    // branch and are ignored. The cast is technically unsound only if a third
    // party emits a log with the same Anchor-event discriminator, which the
    // EventParser scopes out by program ID.
    const events = rawEvents as unknown as BracketChainEvent[];

    let handled = 0;
    for (const evt of events) {
      // C10 version guard: reject events whose first field isn't the version
      // this parser was built for — silent decode of a changed layout is worse
      // than a dropped event. Emits the `unknownEventVersion` metric.
      const version = (evt.data as { event_version?: number }).event_version;
      if (version !== HeliusParserService.EVENT_VERSION_V1) {
        this.unknownEventVersionCount++;
        this.logger.warn(
          `unknownEventVersion: skipping ${evt.name} with event_version=${String(version)} ` +
            `(expected ${HeliusParserService.EVENT_VERSION_V1}); total=${this.unknownEventVersionCount}`,
        );
        continue;
      }
      // L-3: isolate each event. A handler that throws (e.g. an unknown enum
      // index from a future program build, or a transient DB error) must NOT
      // abort the sibling events decoded from the SAME tx — those would
      // otherwise bubble to processBatch and be dropped wholesale, with
      // reconciliation as the only (slow) backstop. Per-event catch lets the
      // good siblings persist now; the failed one is logged for reconcile.
      try {
        if (await this.dispatchEvent(evt, tx, signature)) handled++;
      } catch (err) {
        this.logger.error(
          `Failed to handle ${evt.name} in tx ${signature}: ` +
            `${err instanceof Error ? err.message : String(err)} — siblings continue`,
        );
      }
    }
    return handled;
  }

  /**
   * Dispatch one decoded event to its handler. Returns true when the event
   * matched a known case (so the caller can count it). Throws are surfaced to
   * the per-event guard in {@link processTransaction}.
   */
  private async dispatchEvent(
    evt: BracketChainEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<boolean> {
    switch (evt.name) {
      case 'TournamentCreated':
        await this.handleTournamentCreated(evt.data, tx, signature);
        return true;
      case 'ParticipantRegistered':
        await this.handleParticipantRegistered(evt.data, tx, signature);
        return true;
      case 'TournamentStarted':
        await this.handleTournamentStarted(evt.data, tx, signature);
        return true;
      case 'MatchReported':
        await this.handleMatchReported(evt.data, tx, signature);
        return true;
      case 'TournamentCompleted':
        await this.handleTournamentCompleted(evt.data, tx, signature);
        return true;
      case 'TournamentCancelled':
        await this.handleTournamentCancelled(evt.data, tx, signature);
        return true;
      case 'RefundIssued':
        await this.handleRefundIssued(evt.data, signature);
        return true;
      case 'ResultProposed':
        await this.handleResultProposed(evt.data, tx, signature);
        return true;
      case 'ResultDisputed':
        await this.handleResultDisputed(evt.data, tx, signature);
        return true;
      case 'ResultClaimed':
        await this.handleResultClaimed(evt.data, tx, signature);
        return true;
      case 'DisputeResolved':
        await this.handleDisputeResolved(evt.data, tx, signature);
        return true;
      case 'MatchLobbyCommitted':
        await this.handleMatchLobbyCommitted(evt.data, tx, signature);
        return true;
      case 'MatchFeedBound':
        await this.handleMatchFeedBound(evt.data, tx, signature);
        return true;
      default:
        // Unknown event — ignore. Future events should be added explicitly.
        return false;
    }
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private async handleTournamentCreated(
    data: TournamentCreatedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const organizer = pubkeyToString(data.organizer);
    // Event field is `token_mint` (snake_case in IDL). Always was — earlier
    // indexer code read `data.usdc_mint` which was a latent bug because the
    // Rust event struct named it `token_mint` from day one (multi-token-ready).
    const tokenMint = pubkeyToString(data.token_mint);
    const entryFee = toBigInt(data.entry_fee);
    // Phase 2.5: organizer's optional top-up to the prize pool. Defaults to 0
    // for back-compat with re-played pre-2.5 events (where the field is absent).
    const organizerDeposit =
      data.organizer_deposit !== undefined
        ? toBigInt(data.organizer_deposit)
        : 0n;
    const maxParticipants = toNumber(data.max_participants);
    const presetIndex = toNumber(data.payout_preset);
    const payoutPreset = PAYOUT_PRESET_BY_INDEX[presetIndex];
    const registrationDeadlineSec = toNumber(data.registration_deadline);

    if (!payoutPreset) {
      throw new Error(
        `Unknown payoutPreset index ${presetIndex} in tx ${signature}`,
      );
    }

    // Name was added to TournamentCreated in program v0.2.x — see events.rs.
    // Older events emitted before the upgrade lack the field and decode to ''.
    // Defensive coercion: untrusted on-chain string, clamp to MAX_TOURNAMENT_NAME_LEN
    // to match the program's enforced bound.
    const rawName = typeof data.name === 'string' ? data.name : '';
    const name = rawName.slice(0, 32);

    // Block timestamp from Helius — fall back to now if absent.
    const txTimestamp = tx.timestamp ?? tx.blockTime;
    const createdAt = txTimestamp ? new Date(txTimestamp * 1000) : new Date();
    const chainSlotAtWrite = extractSlot(tx);

    await this.prisma.tournament.upsert({
      where: { address },
      create: {
        address,
        organizer,
        name,
        tokenMint,
        entryFee,
        organizerDeposit,
        maxParticipants,
        payoutPreset,
        registrationDeadline: new Date(registrationDeadlineSec * 1000),
        status: TournamentStatus.Registration,
        createdAt,
        createdTxSig: signature,
        chainSlotAtWrite,
      },
      update: {
        // Idempotent re-delivery: only refresh fields the source-of-truth event sets.
        organizer,
        name,
        tokenMint,
        entryFee,
        organizerDeposit,
        maxParticipants,
        payoutPreset,
        registrationDeadline: new Date(registrationDeadlineSec * 1000),
        createdTxSig: signature,
        chainSlotAtWrite,
      },
    });
    this.logger.log(
      `tournamentCreated ${address} (preset=${payoutPreset}, deposit=${organizerDeposit})`,
    );
  }

  private async handleTournamentCompleted(
    data: TournamentCompletedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const champion = pubkeyToString(data.champion);
    const grossPool = toBigInt(data.gross_pool);
    const feeAmount = toBigInt(data.fee_amount);
    const netPool = toBigInt(data.net_pool);
    const completedAtSec = toNumber(data.completed_at);

    const chainSlotAtWrite = extractSlot(tx);

    // Use a transaction so Tournament update + Payout inserts are atomic.
    await this.prisma.$transaction(async (txn) => {
      await txn.tournament.update({
        where: { address },
        data: {
          status: TournamentStatus.Completed,
          champion,
          grossPool,
          feeAmount,
          netPool,
          completedAt: new Date(completedAtSec * 1000),
          completedTxSig: signature,
          chainSlotAtWrite,
        },
      });

      // Phase 5.2 (P6-4 fix): derive payouts from the event itself instead of
      // tokenTransfers. The TournamentCompleted event carries `placement_payouts`
      // (per-place [recipient, amount]) + `treasury_recipient` (the fee receiver) —
      // self-contained and immune to Helius `tokenTransfers` being empty.
      // Old `derivePayoutsFromTransfers(...)` left as fallback below for events
      // missing the field (re-replays of pre-event-upgrade txs).
      const placementPayouts = parsePlacementPayouts(data.placement_payouts);
      const treasuryRecipient =
        data.treasury_recipient !== undefined
          ? pubkeyToString(data.treasury_recipient)
          : null;

      const eventDerivedPayouts: Array<{
        recipient: string;
        amount: bigint;
        kind: PayoutKind;
        placement: number | null;
      }> = [];

      for (const p of placementPayouts) {
        eventDerivedPayouts.push({
          recipient: p.recipient,
          amount: p.amount,
          kind: PayoutKind.Prize,
          placement: p.place,
        });
      }
      if (treasuryRecipient && feeAmount > 0n) {
        eventDerivedPayouts.push({
          recipient: treasuryRecipient,
          amount: feeAmount,
          kind: PayoutKind.Fee,
          placement: null,
        });
      }

      // Fall back to legacy tokenTransfer parsing if the event was emitted by
      // an older program version that didn't include placement_payouts (only
      // possible when re-replaying historical webhooks; live txs always carry
      // it post-event-upgrade).
      const payouts =
        eventDerivedPayouts.length > 0
          ? eventDerivedPayouts
          : derivePayoutsFromTransfers(
              tx,
              address,
              feeAmount,
              this.tokenMintFilter,
            );

      if (payouts.length === 0) {
        const transferCount = tx.tokenTransfers?.length ?? 0;
        this.logger.warn(
          `tournamentCompleted ${address}: 0 payouts derived ` +
            `(event placement_payouts missing, tokenTransfers=${transferCount}, ` +
            `mintFilter=${this.tokenMintFilter ?? 'none'}). ` +
            `Tournament row updated, Payout table NOT populated — UI will show "Pending".`,
        );
        return;
      }
      this.logger.log(
        `tournamentCompleted ${address}: inserted ${payouts.length} payout rows ` +
          `(${payouts.filter((p) => p.kind === PayoutKind.Prize).length} prize, ` +
          `${payouts.filter((p) => p.kind === PayoutKind.Fee).length} fee, ` +
          `source=${eventDerivedPayouts.length > 0 ? 'event' : 'tokenTransfers'})`,
      );

      // createMany with skipDuplicates handles webhook redelivery via the
      // (txSignature, recipient, kind) unique index.
      await txn.payout.createMany({
        data: payouts.map((p) => ({
          tournamentAddress: address,
          recipient: p.recipient,
          amount: p.amount,
          kind: p.kind,
          placement: p.placement ?? null,
          txSignature: signature,
        })),
        skipDuplicates: true,
      });
    });
    this.logger.log(`tournamentCompleted ${address} → champion ${champion}`);
  }

  private async handleParticipantRegistered(
    data: ParticipantRegisteredEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const wallet = pubkeyToString(data.wallet);
    const seedIndex = toNumber(data.participant_index);
    const chainSlotAtWrite = extractSlot(tx);
    const txTimestamp = tx.timestamp ?? tx.blockTime;
    const registeredAt = txTimestamp
      ? new Date(txTimestamp * 1000)
      : new Date();

    // Foreign-key guard: skip if the parent Tournament row isn't in the DB
    // yet (out-of-order webhook delivery — TournamentCreated may arrive after
    // ParticipantRegistered if Helius batches them in reverse). Phase 5.4
    // reconciliation cron will backfill from chain.
    const tournamentExists = await this.prisma.tournament.findUnique({
      where: { address: tournamentAddress },
      select: { address: true },
    });
    if (!tournamentExists) {
      this.logger.warn(
        `participantRegistered for unknown tournament ${tournamentAddress} — skipping (will be backfilled by reconciliation)`,
      );
      return;
    }

    await this.prisma.participant.upsert({
      where: {
        tournamentAddress_wallet: { tournamentAddress, wallet },
      },
      create: {
        tournamentAddress,
        wallet,
        seedIndex,
        registeredAt,
        registeredTxSig: signature,
        chainSlotAtWrite,
      },
      update: {
        // Idempotent re-delivery refreshes seedIndex (in case of program rewrite)
        // but never resets refundPaid, since RefundIssued is the source of truth there.
        seedIndex,
        registeredTxSig: signature,
        chainSlotAtWrite,
      },
    });
    this.logger.log(
      `participantRegistered ${tournamentAddress} → ${wallet} (seedIndex=${seedIndex})`,
    );
  }

  private async handleTournamentStarted(
    data: TournamentStartedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const startedAtSec = toNumber(data.started_at);
    const chainSlotAtWrite = extractSlot(tx);

    // Flip status to Active. The program emits TournamentStarted in the final
    // start_tournament chunk that completes bracket initialization, so by the
    // time we see this event the on-chain status IS Active. Subsequent chunks
    // (if any retried) won't re-emit because the program guards by status.
    await this.prisma.tournament.update({
      where: { address },
      data: {
        status: TournamentStatus.Active,
        chainSlotAtWrite,
      },
    });
    this.logger.log(
      `tournamentStarted ${address} (startedAt=${new Date(startedAtSec * 1000).toISOString()}, signature=${signature})`,
    );
  }

  private async handleMatchReported(
    data: MatchReportedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    // `bracket` added to the event in Stage B (C9); absent on pre-upgrade
    // replays → default 0 (single-elim).
    const bracket = data.bracket !== undefined ? toNumber(data.bracket) : 0;
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const winner = pubkeyToString(data.winner);
    const reportedAtSec = toNumber(data.reported_at);
    const chainSlotAtWrite = extractSlot(tx);

    // Foreign-key guard (same pattern as participants).
    const tournamentExists = await this.prisma.tournament.findUnique({
      where: { address: tournamentAddress },
      select: { address: true },
    });
    if (!tournamentExists) {
      this.logger.warn(
        `matchReported for unknown tournament ${tournamentAddress} — skipping (will be backfilled by reconciliation)`,
      );
      return;
    }

    // Lean indexer: we don't store playerA/playerB on insert because
    // MatchReported doesn't carry them (they're inferred on-chain from
    // bracket advancement). Phase 5.4 reconciliation cron will pull full
    // MatchNode account state via getProgramAccounts to fill the gaps.
    // For now, frontend reads pending matches from chain via SWR fallback.
    await this.prisma.match.upsert({
      where: {
        tournamentAddress_bracket_round_matchIndex: {
          tournamentAddress,
          bracket,
          round,
          matchIndex,
        },
      },
      create: {
        tournamentAddress,
        bracket,
        round,
        matchIndex,
        winner,
        status: MatchStatus.Completed,
        reportedAt: new Date(reportedAtSec * 1000),
        reportedTxSig: signature,
        chainSlotAtWrite,
      },
      update: {
        winner,
        status: MatchStatus.Completed,
        reportedAt: new Date(reportedAtSec * 1000),
        reportedTxSig: signature,
        chainSlotAtWrite,
      },
    });
    this.logger.log(
      `matchReported ${tournamentAddress} b${bracket}r${round}m${matchIndex} → winner=${winner}`,
    );
  }

  private async handleTournamentCancelled(
    data: TournamentCancelledEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const address = pubkeyToString(data.tournament);
    const chainSlotAtWrite = extractSlot(tx);

    // M-1: cancellation is a terminal state — stamp `completedAt` so the
    // close-terminal rent-reclaim cron (gate G7) and the reconciliation
    // recent-terminal window treat it like any other terminal tournament.
    // Without this the column stayed null and cancelled tournaments were never
    // closed. Prefer the on-chain `cancelled_at`; fall back to block time, then now.
    const txTimestamp = tx.timestamp ?? tx.blockTime;
    const completedAt =
      data.cancelled_at != null
        ? new Date(toNumber(data.cancelled_at) * 1000)
        : txTimestamp
          ? new Date(txTimestamp * 1000)
          : new Date();

    await this.prisma.tournament.update({
      where: { address },
      data: {
        status: TournamentStatus.Cancelled,
        completedAt,
        chainSlotAtWrite,
      },
    });
    this.logger.log(`tournamentCancelled ${address} (signature=${signature})`);
  }

  private async handleRefundIssued(
    data: RefundIssuedEvent,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const recipient = pubkeyToString(data.wallet);
    const amount = toBigInt(data.amount);

    // Refund event references a tournament that may not yet be in our DB if
    // we somehow missed its TournamentCreated. Skip silently — the row will
    // get re-emitted on subsequent flow / V1 reconciliation.
    const tournament = await this.prisma.tournament.findUnique({
      where: { address: tournamentAddress },
      select: { address: true, organizer: true, organizerDeposit: true },
    });
    if (!tournament) {
      this.logger.warn(
        `refundIssued for unknown tournament ${tournamentAddress}, skipping`,
      );
      return;
    }

    // Phase 2.5: cancel emits one RefundIssued per refunded participant +
    // (optionally) one for the organizer's deposit. Distinguish by
    // recipient == tournament.organizer && tournament.organizerDeposit > 0,
    // because organizer_deposit_refunded flag isn't on this event payload.
    const isOrganizerRefund =
      recipient === tournament.organizer && tournament.organizerDeposit > 0n;
    const kind = isOrganizerRefund
      ? PayoutKind.OrganizerRefund
      : PayoutKind.Refund;

    await this.prisma.payout.upsert({
      where: {
        txSignature_recipient_kind: {
          txSignature: signature,
          recipient,
          kind,
        },
      },
      create: {
        tournamentAddress,
        recipient,
        amount,
        kind,
        txSignature: signature,
      },
      update: { amount },
    });

    // Phase 5.2: also flip Participant.refundPaid for entry-fee refunds so
    // the participants endpoint reflects refund state without a follow-up
    // RPC. updateMany is a no-op when the participant row doesn't exist
    // (e.g. organizer refund or out-of-order delivery — Phase 5.4 cron
    // will reconcile from chain).
    if (kind === PayoutKind.Refund) {
      await this.prisma.participant.updateMany({
        where: { tournamentAddress, wallet: recipient },
        data: { refundPaid: true },
      });
    }

    this.logger.log(
      `refundIssued ${tournamentAddress} → ${recipient} (${amount}, kind=${kind})`,
    );
  }

  // ── Stage B settlement-envelope handlers (B-14) ───────────────────────────
  // Each writes the on-chain MatchNode envelope onto the read-cache Match row
  // and derives the PRD §5.2 UI status. No notifications / WS: per the product
  // architecture (Product Definition §4.1) live UI updates ride Solana account
  // subscriptions in the SDK — "no custom WebSocket server needed" — and
  // browser-push notifications are a V2 concern.

  /**
   * Upsert the settlement envelope onto a Match row, creating a bare row when
   * the match wasn't seeded yet (lean indexer — pending matches live only on
   * chain until a finalize/propose event names them). Never downgrades a
   * Completed match: Helius may redeliver a stale propose/dispute webhook after
   * the match already finalized. Returns false (and logs) when the parent
   * tournament isn't in the DB yet — Phase 5.4 reconciliation backfills it.
   */
  private async applyMatchEnvelope(args: {
    tournamentAddress: string;
    bracket: number;
    round: number;
    matchIndex: number;
    desiredStatus: MatchStatus;
    envelope: MatchEnvelopeFields;
    chainSlotAtWrite: bigint;
  }): Promise<boolean> {
    const { tournamentAddress, bracket, round, matchIndex } = args;

    const tournamentExists = await this.prisma.tournament.findUnique({
      where: { address: tournamentAddress },
      select: { address: true },
    });
    if (!tournamentExists) {
      this.logger.warn(
        `match envelope for unknown tournament ${tournamentAddress} — skipping (will be backfilled by reconciliation)`,
      );
      return false;
    }

    // M-3: atomic terminal-status guard. The old read-then-write
    // (findUnique(status) → upsert) had a TOCTOU gap: two concurrent webhook
    // POSTs for the same match could read a non-terminal status and then both
    // write, letting a redelivered earlier-stage event clobber Completed back
    // to PendingConfirmation / Disputed. A conditional `updateMany` closes the
    // gap — under READ COMMITTED the UPDATE takes a row lock and re-evaluates
    // `status != Completed` at lock time, so once a row is Completed no
    // envelope write can move it back.
    const guard = {
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      status: { not: MatchStatus.Completed },
    };
    const data = {
      status: args.desiredStatus,
      chainSlotAtWrite: args.chainSlotAtWrite,
      ...args.envelope,
    };

    const { count } = await this.prisma.match.updateMany({
      where: guard,
      data,
    });
    if (count > 0) return true;

    // count === 0 → the row is missing OR already Completed. Try to create it;
    // a unique-constraint violation means it exists, so re-run the guarded
    // update (handles a concurrent create racing us into existence). A second
    // count === 0 means it is Completed — the intended no-op.
    try {
      await this.prisma.match.create({
        data: { tournamentAddress, bracket, round, matchIndex, ...data },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        await this.prisma.match.updateMany({ where: guard, data });
      } else {
        throw e;
      }
    }
    return true;
  }

  private async handleResultProposed(
    data: ResultProposedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const sourceIndex = toNumber(data.source);
    const proposalSource = PROPOSAL_SOURCE_BY_INDEX[sourceIndex];
    if (!proposalSource || proposalSource === ProposalSource.None) {
      throw new Error(
        `ResultProposed with invalid source=${sourceIndex} in tx ${signature}`,
      );
    }
    const proposer = pubkeyToString(data.proposer);
    const proposedWinner = pubkeyToString(data.proposed_winner);
    const proposedAt = new Date(toNumber(data.proposed_at) * 1000);
    const claimDeadline = new Date(toNumber(data.claim_deadline) * 1000);

    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.PendingConfirmation,
      chainSlotAtWrite: extractSlot(tx),
      envelope: {
        proposalSource,
        proposer,
        proposedWinner,
        proposedAt,
        claimDeadline,
        disputed: false,
      },
    });
    if (ok) {
      this.logger.log(
        `resultProposed ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `source=${proposalSource} proposer=${proposer} → ${proposedWinner}`,
      );
    }
  }

  private async handleResultDisputed(
    data: ResultDisputedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const disputeReason = toNumber(data.dispute_reason);
    // `claim_deadline` is re-armed to the +24h force-claim window on dispute.
    const claimDeadline = new Date(toNumber(data.force_claim_deadline) * 1000);

    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.Disputed,
      chainSlotAtWrite: extractSlot(tx),
      envelope: { disputed: true, disputeReason, claimDeadline },
    });
    if (ok) {
      this.logger.log(
        `resultDisputed ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `reason=${disputeReason} (signature=${signature})`,
      );
    }
  }

  private async handleResultClaimed(
    data: ResultClaimedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const winner = pubkeyToString(data.winner);
    const forced = data.forced === true;
    const claimedAt = new Date(toNumber(data.claimed_at) * 1000);

    // Finalize: same tx also emits MatchReported (which sets winner+Completed).
    // We set Completed too so ordering within the batch is irrelevant.
    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.Completed,
      chainSlotAtWrite: extractSlot(tx),
      envelope: {
        winner,
        reportedAt: claimedAt,
        reportedTxSig: signature,
      },
    });
    if (ok) {
      this.logger.log(
        `resultClaimed ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `winner=${winner} forced=${forced}`,
      );
    }
  }

  private async handleDisputeResolved(
    data: DisputeResolvedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const arbitrator = pubkeyToString(data.arbitrator);
    const winner = pubkeyToString(data.winner);
    const resolvedAt = new Date(toNumber(data.resolved_at) * 1000);

    // Organizer/arbitrator adjudication. Same tx emits MatchReported too.
    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.Completed,
      chainSlotAtWrite: extractSlot(tx),
      envelope: {
        winner,
        reportedAt: resolvedAt,
        reportedTxSig: signature,
      },
    });
    if (ok) {
      this.logger.log(
        `disputeResolved ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `arbitrator=${arbitrator} → winner=${winner}`,
      );
    }
  }

  // ── Stage C (V1.2 Oracle settlement) commit/bind ceremony handlers ────────
  // Both events fire only for Oracle-mode tournaments. The match stays Active
  // on-chain through both ix, so we don't move status; applyMatchEnvelope's
  // upsert path will create a bare row if commit lands before any prior event
  // (lean indexer — pending matches aren't seeded). `playerAGameId` /
  // `playerBGameId` / `expectedFeedHash` live on the on-chain MatchCommitment
  // but aren't carried by either event; the reconciliation cron backfills them.

  private async handleMatchLobbyCommitted(
    data: MatchLobbyCommittedEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    // `new Uint8Array(numberArray)` allocates a fresh `ArrayBuffer` (not
    // `SharedArrayBuffer`), which is what Prisma's `Bytes` column expects.
    const lobbyId = new Uint8Array(data.lobby_id);
    const committedAt = new Date(toNumber(data.committed_at) * 1000);

    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.Active,
      chainSlotAtWrite: extractSlot(tx),
      envelope: { lobbyId, committedAt },
    });
    if (ok) {
      this.logger.log(
        `matchLobbyCommitted ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `lobby=0x${bytesToHex(lobbyId)} (signature=${signature})`,
      );
    }
  }

  private async handleMatchFeedBound(
    data: MatchFeedBoundEvent,
    tx: HeliusTransaction,
    signature: string,
  ): Promise<void> {
    const tournamentAddress = pubkeyToString(data.tournament);
    const bracket = toNumber(data.bracket);
    const round = toNumber(data.round);
    const matchIndex = toNumber(data.match_index);
    const switchboardFeed = pubkeyToString(data.switchboard_feed);

    const ok = await this.applyMatchEnvelope({
      tournamentAddress,
      bracket,
      round,
      matchIndex,
      desiredStatus: MatchStatus.Active,
      chainSlotAtWrite: extractSlot(tx),
      envelope: { switchboardFeed },
    });
    if (ok) {
      this.logger.log(
        `matchFeedBound ${tournamentAddress} b${bracket}r${round}m${matchIndex} ` +
          `feed=${switchboardFeed} (signature=${signature})`,
      );
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function extractLogs(tx: HeliusTransaction): string[] | undefined {
  return tx.meta?.logMessages ?? tx.logs ?? tx.logMessages;
}

/**
 * Phase 5.1: Solana slot of the webhook tx, used as the row's "freshness
 * watermark". Frontend SWR layer compares this to current cluster slot and
 * triggers a chain-side reconcile if the gap exceeds N slots.
 *
 * Defensive: webhook payloads occasionally arrive without `slot` (raw vs
 * enhanced shape mismatch). Returning 0n in that case keeps the row writable
 * but signals "unknown freshness" — readers conservatively treat this as
 * stale and re-fetch from chain.
 */
function extractSlot(tx: HeliusTransaction): bigint {
  if (typeof tx.slot === 'number' && Number.isFinite(tx.slot) && tx.slot >= 0) {
    return BigInt(Math.floor(tx.slot));
  }
  return 0n;
}

function extractSignature(tx: HeliusTransaction): string | undefined {
  return tx.signature ?? tx.transaction?.signatures?.[0];
}

/**
 * Phase 5.2 / P6-4 fix: parse `placement_payouts: Vec<PlacementPayout>` from
 * the TournamentCompleted event. Each entry is `{ place: u8, recipient: Pubkey,
 * amount: u64 }`. Returns [] if the field is missing (pre-event-upgrade replay)
 * or malformed — caller falls back to legacy tokenTransfer parsing.
 */
function parsePlacementPayouts(
  raw: unknown,
): Array<{ place: number; recipient: string; amount: bigint }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ place: number; recipient: string; amount: bigint }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    try {
      out.push({
        place: toNumber(e.place),
        recipient: pubkeyToString(e.recipient),
        amount: toBigInt(e.amount),
      });
    } catch {
      // Skip malformed rows — best-effort.
    }
  }
  return out;
}

/** Lowercase hex of a byte array — for logging the on-chain `lobby_id` etc. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function pubkeyToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof PublicKey) return value.toBase58();
  // Anchor's BorshCoder may return PublicKey as object with `_bn` etc — fall back to string()
  if (
    value &&
    typeof (value as { toString?: () => string }).toString === 'function'
  ) {
    return (value as { toString: () => string }).toString();
  }
  throw new Error(
    `Cannot coerce value to pubkey string: ${JSON.stringify(value)}`,
  );
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value instanceof BN) return BigInt(value.toString());
  if (
    value &&
    typeof (value as { toString?: () => string }).toString === 'function'
  ) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Cannot coerce value to bigint: ${JSON.stringify(value)}`);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value instanceof BN) return value.toNumber();
  throw new Error(`Cannot coerce value to number: ${JSON.stringify(value)}`);
}

interface DerivedPayout {
  recipient: string;
  amount: bigint;
  kind: PayoutKind;
  placement: number | null;
}

/**
 * Walk the tx's tokenTransfers and turn vault-out transfers into Payout rows.
 * Heuristic for fee: the transfer whose amount equals `feeAmount` is the
 * protocol fee; remaining transfers are prizes ordered as they appear (which
 * matches the on-chain CPI order: 1st, 2nd, 3rd, …).
 *
 * If tokenTransfers is missing (Helius "raw" webhook) we return [] — Tournament
 * row still gets the aggregate gross/fee/net from the event itself.
 */
function derivePayoutsFromTransfers(
  tx: HeliusTransaction,
  tournamentAddress: string,
  feeAmount: bigint,
  tokenMintFilter: string | null,
): DerivedPayout[] {
  const transfers = tx.tokenTransfers;
  if (!transfers || transfers.length === 0) return [];

  // Vault is owned by the Tournament PDA (token::authority = tournament).
  const fromVault = transfers.filter((t) => {
    if (t.fromUserAccount !== tournamentAddress) return false;
    if (tokenMintFilter && t.mint && t.mint !== tokenMintFilter) return false;
    return true;
  });
  if (fromVault.length === 0) return [];

  let feeAssigned = false;
  let placementCounter = 1;
  const out: DerivedPayout[] = [];

  for (const t of fromVault) {
    const amount = transferAmountToBigInt(t);
    if (amount === null) continue;
    const recipient = t.toUserAccount;
    if (!recipient) continue;

    if (!feeAssigned && amount === feeAmount) {
      out.push({ recipient, amount, kind: PayoutKind.Fee, placement: null });
      feeAssigned = true;
    } else {
      out.push({
        recipient,
        amount,
        kind: PayoutKind.Prize,
        placement: placementCounter++,
      });
    }
  }
  return out;
}

function transferAmountToBigInt(t: HeliusTokenTransfer): bigint | null {
  // Prefer raw — exact, no float rounding.
  const raw = t.rawTokenAmount?.tokenAmount;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      /* fall through */
    }
  }
  if (
    typeof t.tokenAmount === 'number' &&
    t.rawTokenAmount?.decimals !== undefined
  ) {
    const decimals = t.rawTokenAmount.decimals;
    return BigInt(Math.round(t.tokenAmount * 10 ** decimals));
  }
  return null;
}
