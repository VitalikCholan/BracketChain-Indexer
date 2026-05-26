/**
 * Hand-typed event shapes matching `BorshCoder.parseLogs(...)` output for the
 * 7 events emitted by the BracketChain program. The Codama renderers-js@2.x
 * pipeline (Section 2 of the indexer plan) does not emit event decoders, so
 * we keep `BorshCoder` for events and only adopt Codama for
 * accounts/instructions. Until that split lands, these interfaces give the
 * parser handlers static typing without requiring a generator round-trip on
 * every IDL change.
 *
 * Polymorphic field types (`EventPubkey`, `EventBigInt`, `EventNumber`)
 * reflect the fact that BorshCoder returns `PublicKey` / `BN` instances at
 * runtime, while the unit-test suite passes plain JSON (strings, numbers).
 * The `pubkeyToString` / `toBigInt` / `toNumber` helpers in
 * `helius-parser.service.ts` are tolerant of both shapes.
 *
 * Fields marked optional (`?`) reflect on-chain event versions where the
 * field was added after MVP — replaying historical webhooks against the
 * current parser must still decode cleanly.
 */
import type { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

export type EventPubkey = string | PublicKey | { toString(): string };
export type EventBigInt =
  | bigint
  | number
  | string
  | BN
  | { toString(): string };
export type EventNumber = number | bigint | string | BN;

export interface TournamentCreatedEvent {
  tournament: EventPubkey;
  organizer: EventPubkey;
  token_mint: EventPubkey;
  entry_fee: EventBigInt;
  /** Added in Phase 2.5; pre-2.5 replays decode without the field. */
  organizer_deposit?: EventBigInt;
  max_participants: EventNumber;
  payout_preset: EventNumber;
  registration_deadline: EventNumber;
  /** Added in v0.2.x (Phase 2.6); pre-2.6 replays decode without the field. */
  name?: string;
}

export interface ParticipantRegisteredEvent {
  tournament: EventPubkey;
  wallet: EventPubkey;
  participant_index: EventNumber;
}

export interface TournamentStartedEvent {
  tournament: EventPubkey;
  bracket_size: EventNumber;
  participant_count: EventNumber;
  seed_hash: number[];
  started_at: EventNumber;
}

export interface MatchReportedEvent {
  tournament: EventPubkey;
  /** Bracket lane (C9). Added in Stage B; `0` for single-elim. Optional so
   *  pre-Stage-B webhook replays still decode (parser defaults to 0). */
  bracket?: EventNumber;
  round: EventNumber;
  match_index: EventNumber;
  winner: EventPubkey;
  reported_at: EventNumber;
}

export interface PlacementPayoutEntry {
  place: EventNumber;
  recipient: EventPubkey;
  amount: EventBigInt;
}

export interface TournamentCompletedEvent {
  tournament: EventPubkey;
  champion: EventPubkey;
  gross_pool: EventBigInt;
  fee_amount: EventBigInt;
  net_pool: EventBigInt;
  completed_at: EventNumber;
  /** Added in Phase 5.2 (P6-4 fix); pre-upgrade replays fall back to tokenTransfers. */
  placement_payouts?: PlacementPayoutEntry[];
  treasury_recipient?: EventPubkey;
}

export interface TournamentCancelledEvent {
  tournament: EventPubkey;
  authority: EventPubkey;
  cancelled_at: EventNumber;
}

export interface RefundIssuedEvent {
  tournament: EventPubkey;
  wallet: EventPubkey;
  amount: EventBigInt;
}

// ── Stage B: player-reported / oracle settlement envelope events (B-14) ──────
// `MatchReported` stays the canonical "match final, advance the bracket" signal
// emitted by every finalize path. The four below are the settlement-envelope
// granularity layered on top: who proposed, who disputed, and how a pending
// result ultimately closed. All carry the (bracket, round, match_index) key.

export interface ResultProposedEvent {
  tournament: EventPubkey;
  bracket: EventNumber;
  round: EventNumber;
  match_index: EventNumber;
  /** `ProposalSource` discriminant (1 = Player, 2 = Oracle, 3 = GameServer). */
  source: EventNumber;
  proposer: EventPubkey;
  proposed_winner: EventPubkey;
  /** Deadline after which `claim_result` may permissionlessly finalize. */
  claim_deadline: EventNumber;
  proposed_at: EventNumber;
}

export interface ResultDisputedEvent {
  tournament: EventPubkey;
  bracket: EventNumber;
  round: EventNumber;
  match_index: EventNumber;
  disputer: EventPubkey;
  dispute_reason: EventNumber;
  /** Re-armed deadline after which `force_claim_disputed` may finalize. */
  force_claim_deadline: EventNumber;
  disputed_at: EventNumber;
}

export interface ResultClaimedEvent {
  tournament: EventPubkey;
  bracket: EventNumber;
  round: EventNumber;
  match_index: EventNumber;
  winner: EventPubkey;
  /** `true` when finalized via `force_claim_disputed` rather than `claim_result`. */
  forced: boolean;
  claimed_at: EventNumber;
}

export interface DisputeResolvedEvent {
  tournament: EventPubkey;
  bracket: EventNumber;
  round: EventNumber;
  match_index: EventNumber;
  arbitrator: EventPubkey;
  winner: EventPubkey;
  resolved_at: EventNumber;
}

export type BracketChainEvent =
  | { name: 'TournamentCreated'; data: TournamentCreatedEvent }
  | { name: 'ParticipantRegistered'; data: ParticipantRegisteredEvent }
  | { name: 'TournamentStarted'; data: TournamentStartedEvent }
  | { name: 'MatchReported'; data: MatchReportedEvent }
  | { name: 'TournamentCompleted'; data: TournamentCompletedEvent }
  | { name: 'TournamentCancelled'; data: TournamentCancelledEvent }
  | { name: 'RefundIssued'; data: RefundIssuedEvent }
  | { name: 'ResultProposed'; data: ResultProposedEvent }
  | { name: 'ResultDisputed'; data: ResultDisputedEvent }
  | { name: 'ResultClaimed'; data: ResultClaimedEvent }
  | { name: 'DisputeResolved'; data: DisputeResolvedEvent };
