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

export type BracketChainEvent =
  | { name: 'TournamentCreated'; data: TournamentCreatedEvent }
  | { name: 'ParticipantRegistered'; data: ParticipantRegisteredEvent }
  | { name: 'TournamentStarted'; data: TournamentStartedEvent }
  | { name: 'MatchReported'; data: MatchReportedEvent }
  | { name: 'TournamentCompleted'; data: TournamentCompletedEvent }
  | { name: 'TournamentCancelled'; data: TournamentCancelledEvent }
  | { name: 'RefundIssued'; data: RefundIssuedEvent };
