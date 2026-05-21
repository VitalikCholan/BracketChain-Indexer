import { HeliusParserService } from './helius-parser.service';
import type { HeliusTransaction } from './dto/helius-payload.dto';
import type {
  MatchReportedEvent,
  ParticipantRegisteredEvent,
  RefundIssuedEvent,
  TournamentCancelledEvent,
  TournamentCompletedEvent,
  TournamentCreatedEvent,
  TournamentStartedEvent,
} from './event-types';

const PROGRAM_ID = 'AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1';
const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';
const ORGANIZER = 'Org11111111111111111111111111111111111111111';
const PLAYER_A = 'PlayerA1111111111111111111111111111111111111';
const PLAYER_B = 'PlayerB1111111111111111111111111111111111111';
const TOKEN_MINT = 'Mint1111111111111111111111111111111111111111';
const TREASURY = 'Treas111111111111111111111111111111111111111';

const TX_SIGNATURE = 'sig111111111111111111111111111111111111';
const TX_TIMESTAMP_SEC = 1_715_000_000;
const TX_SLOT = 250_000_000;

function makeTx(overrides: Partial<HeliusTransaction> = {}): HeliusTransaction {
  return {
    signature: TX_SIGNATURE,
    timestamp: TX_TIMESTAMP_SEC,
    slot: TX_SLOT,
    ...overrides,
  };
}

/**
 * Hand-rolled PrismaService mock — exposes the exact subset of methods the
 * parser touches. Keeps the suite dependency-free (no jest-mock-extended) and
 * fast (~under 1s per test).
 */
function makePrismaMock() {
  const mock = {
    tournament: {
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({ address: TOURNAMENT_PDA }),
    },
    participant: {
      upsert: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    match: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    payout: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn(async (cb: (txn: unknown) => Promise<unknown>) =>
      cb(mock),
    ),
  };
  return mock;
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeService(prisma: PrismaMock): HeliusParserService {
  process.env.PROGRAM_ID = PROGRAM_ID;
  // TS infers PrismaService's constructor param wide enough that the mock
  // satisfies it without a cast — the runtime contract holds because the
  // parser only touches the methods stubbed in `makePrismaMock`.
  const service = new HeliusParserService(prisma as never);
  service.onModuleInit();
  return service;
}

/**
 * Tests invoke the private `handle*` methods directly via `as any`. This is
 * deliberate: BorshCoder log decoding is exercised by `scripts/test-parser.mjs`
 * (integration), and these unit tests scope to DB persistence + idempotency
 * which is where bugs hide. Mocking EventParser would add ceremony without
 * coverage gain.
 */
type ParserPrivate = {
  handleTournamentCreated: (
    data: TournamentCreatedEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleParticipantRegistered: (
    data: ParticipantRegisteredEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleTournamentStarted: (
    data: TournamentStartedEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleMatchReported: (
    data: MatchReportedEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleTournamentCompleted: (
    data: TournamentCompletedEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleTournamentCancelled: (
    data: TournamentCancelledEvent,
    tx: HeliusTransaction,
    sig: string,
  ) => Promise<void>;
  handleRefundIssued: (data: RefundIssuedEvent, sig: string) => Promise<void>;
};

function asPrivate(service: HeliusParserService): ParserPrivate {
  return service as unknown as ParserPrivate;
}

describe('HeliusParserService', () => {
  let prisma: PrismaMock;
  let service: HeliusParserService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = makeService(prisma);
  });

  // ── TournamentCreated ──────────────────────────────────────────────────────

  describe('TournamentCreated', () => {
    const data = {
      tournament: TOURNAMENT_PDA,
      organizer: ORGANIZER,
      token_mint: TOKEN_MINT,
      entry_fee: '1000000', // 1 USDC (6 decimals)
      organizer_deposit: '500000',
      max_participants: 8,
      payout_preset: 1, // Standard
      registration_deadline: 1_715_500_000,
      name: 'TestCup',
    };

    it('happy-path → upserts Tournament with all fields', async () => {
      await asPrivate(service).handleTournamentCreated(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.tournament.upsert).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.upsert.mock.calls[0][0] as {
        where: { address: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.where.address).toBe(TOURNAMENT_PDA);
      expect(call.create.organizer).toBe(ORGANIZER);
      expect(call.create.tokenMint).toBe(TOKEN_MINT);
      expect(call.create.entryFee).toBe(1_000_000n);
      expect(call.create.organizerDeposit).toBe(500_000n);
      expect(call.create.maxParticipants).toBe(8);
      expect(call.create.payoutPreset).toBe('Standard');
      expect(call.create.name).toBe('TestCup');
      expect(call.create.status).toBe('Registration');
      expect(call.create.createdTxSig).toBe(TX_SIGNATURE);
      expect(call.create.chainSlotAtWrite).toBe(BigInt(TX_SLOT));
    });

    it('re-delivery → upsert is idempotent (same args on both calls)', async () => {
      await asPrivate(service).handleTournamentCreated(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleTournamentCreated(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.tournament.upsert).toHaveBeenCalledTimes(2);
      const a = prisma.tournament.upsert.mock.calls[0][0];
      const b = prisma.tournament.upsert.mock.calls[1][0];
      expect(a).toEqual(b);
    });

    it('back-compat → defaults organizer_deposit to 0n when field absent', async () => {
      const { organizer_deposit: _, ...preMVP } = data;
      void _;
      await asPrivate(service).handleTournamentCreated(
        preMVP,
        makeTx(),
        TX_SIGNATURE,
      );

      const call = prisma.tournament.upsert.mock.calls[0][0] as {
        create: { organizerDeposit: bigint };
      };
      expect(call.create.organizerDeposit).toBe(0n);
    });

    it('throws on unknown payout preset index', async () => {
      await expect(
        asPrivate(service).handleTournamentCreated(
          { ...data, payout_preset: 99 },
          makeTx(),
          TX_SIGNATURE,
        ),
      ).rejects.toThrow(/Unknown payoutPreset index 99/);
    });
  });

  // ── ParticipantRegistered ──────────────────────────────────────────────────

  describe('ParticipantRegistered', () => {
    const data = {
      tournament: TOURNAMENT_PDA,
      wallet: PLAYER_A,
      participant_index: 0,
    };

    it('happy-path → upserts Participant', async () => {
      await asPrivate(service).handleParticipantRegistered(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.participant.upsert).toHaveBeenCalledTimes(1);
      const call = prisma.participant.upsert.mock.calls[0][0] as {
        where: {
          tournamentAddress_wallet: {
            tournamentAddress: string;
            wallet: string;
          };
        };
        create: Record<string, unknown>;
      };
      expect(call.where.tournamentAddress_wallet.tournamentAddress).toBe(
        TOURNAMENT_PDA,
      );
      expect(call.where.tournamentAddress_wallet.wallet).toBe(PLAYER_A);
      expect(call.create.seedIndex).toBe(0);
      expect(call.create.registeredTxSig).toBe(TX_SIGNATURE);
    });

    it('re-delivery → idempotent upsert', async () => {
      await asPrivate(service).handleParticipantRegistered(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleParticipantRegistered(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.participant.upsert).toHaveBeenCalledTimes(2);
    });

    it('out-of-order delivery → skips when Tournament row missing (FK guard)', async () => {
      prisma.tournament.findUnique.mockResolvedValueOnce(null);
      await asPrivate(service).handleParticipantRegistered(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.participant.upsert).not.toHaveBeenCalled();
    });
  });

  // ── TournamentStarted ──────────────────────────────────────────────────────

  describe('TournamentStarted', () => {
    // Handler only reads `tournament`; bracket_size/participant_count/seed_hash
    // are emitted by the program but unused by the lean indexer (kept in the
    // event for downstream consumers). Stubs match what BorshCoder would yield.
    const data: TournamentStartedEvent = {
      tournament: TOURNAMENT_PDA,
      bracket_size: 8,
      participant_count: 8,
      seed_hash: new Array<number>(32).fill(0),
      started_at: TX_TIMESTAMP_SEC,
    };

    it('happy-path → flips status to Active', async () => {
      await asPrivate(service).handleTournamentStarted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.update.mock.calls[0][0] as {
        where: { address: string };
        data: { status: string; chainSlotAtWrite: bigint };
      };
      expect(call.where.address).toBe(TOURNAMENT_PDA);
      expect(call.data.status).toBe('Active');
      expect(call.data.chainSlotAtWrite).toBe(BigInt(TX_SLOT));
    });

    it('re-delivery → second update is a no-op (same args)', async () => {
      await asPrivate(service).handleTournamentStarted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleTournamentStarted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.tournament.update).toHaveBeenCalledTimes(2);
      expect(prisma.tournament.update.mock.calls[0][0]).toEqual(
        prisma.tournament.update.mock.calls[1][0],
      );
    });
  });

  // ── MatchReported ──────────────────────────────────────────────────────────

  describe('MatchReported', () => {
    const data = {
      tournament: TOURNAMENT_PDA,
      round: 1,
      match_index: 0,
      winner: PLAYER_A,
      reported_at: TX_TIMESTAMP_SEC,
    };

    it('happy-path → upserts Match with Completed status', async () => {
      await asPrivate(service).handleMatchReported(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.match.upsert).toHaveBeenCalledTimes(1);
      const call = prisma.match.upsert.mock.calls[0][0] as {
        where: {
          tournamentAddress_round_matchIndex: {
            tournamentAddress: string;
            round: number;
            matchIndex: number;
          };
        };
        create: Record<string, unknown>;
      };
      const key = call.where.tournamentAddress_round_matchIndex;
      expect(key.tournamentAddress).toBe(TOURNAMENT_PDA);
      expect(key.round).toBe(1);
      expect(key.matchIndex).toBe(0);
      expect(call.create.winner).toBe(PLAYER_A);
      expect(call.create.status).toBe('Completed');
    });

    it('re-delivery → idempotent (composite key collision triggers update)', async () => {
      await asPrivate(service).handleMatchReported(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleMatchReported(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.match.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.match.upsert.mock.calls[0][0]).toEqual(
        prisma.match.upsert.mock.calls[1][0],
      );
    });

    it('skips when Tournament row missing (FK guard)', async () => {
      prisma.tournament.findUnique.mockResolvedValueOnce(null);
      await asPrivate(service).handleMatchReported(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.match.upsert).not.toHaveBeenCalled();
    });
  });

  // ── TournamentCompleted ────────────────────────────────────────────────────

  describe('TournamentCompleted', () => {
    const data = {
      tournament: TOURNAMENT_PDA,
      champion: PLAYER_A,
      gross_pool: '8000000', // 8 USDC
      fee_amount: '280000', // 3.5%
      net_pool: '7720000',
      completed_at: TX_TIMESTAMP_SEC,
      placement_payouts: [
        { place: 1, recipient: PLAYER_A, amount: '4632000' },
        { place: 2, recipient: PLAYER_B, amount: '1930000' },
        {
          place: 3,
          recipient: 'Pl3rd111111111111111111111111111111111111111',
          amount: '1158000',
        },
      ],
      treasury_recipient: TREASURY,
    };

    it('happy-path → updates Tournament + inserts 4 payouts (3 prizes + 1 fee)', async () => {
      await asPrivate(service).handleTournamentCompleted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const updateCall = prisma.tournament.update.mock.calls[0][0] as {
        data: { status: string; champion: string; netPool: bigint };
      };
      expect(updateCall.data.status).toBe('Completed');
      expect(updateCall.data.champion).toBe(PLAYER_A);
      expect(updateCall.data.netPool).toBe(7_720_000n);

      expect(prisma.payout.createMany).toHaveBeenCalledTimes(1);
      const payoutCall = prisma.payout.createMany.mock.calls[0][0] as {
        data: Array<{
          kind: string;
          recipient: string;
          amount: bigint;
          placement: number | null;
        }>;
        skipDuplicates: boolean;
      };
      expect(payoutCall.skipDuplicates).toBe(true);
      expect(payoutCall.data).toHaveLength(4);
      expect(payoutCall.data.filter((p) => p.kind === 'Prize')).toHaveLength(3);
      const fees = payoutCall.data.filter((p) => p.kind === 'Fee');
      expect(fees).toHaveLength(1);
      expect(fees[0].recipient).toBe(TREASURY);
      expect(fees[0].amount).toBe(280_000n);
    });

    it('re-delivery → skipDuplicates protects against double-write', async () => {
      await asPrivate(service).handleTournamentCompleted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleTournamentCompleted(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.payout.createMany).toHaveBeenCalledTimes(2);
      for (const call of prisma.payout.createMany.mock.calls) {
        expect((call[0] as { skipDuplicates: boolean }).skipDuplicates).toBe(
          true,
        );
      }
    });

    it('legacy payload (no placement_payouts) → falls back to tokenTransfers', async () => {
      const { placement_payouts: _, treasury_recipient: __, ...legacy } = data;
      void _;
      void __;
      const txWithTransfers = makeTx({
        tokenTransfers: [
          {
            fromUserAccount: TOURNAMENT_PDA,
            toUserAccount: TREASURY,
            mint: TOKEN_MINT,
            rawTokenAmount: { tokenAmount: '280000', decimals: 6 },
          },
          {
            fromUserAccount: TOURNAMENT_PDA,
            toUserAccount: PLAYER_A,
            mint: TOKEN_MINT,
            rawTokenAmount: { tokenAmount: '4632000', decimals: 6 },
          },
        ],
      });

      await asPrivate(service).handleTournamentCompleted(
        legacy,
        txWithTransfers,
        TX_SIGNATURE,
      );

      expect(prisma.payout.createMany).toHaveBeenCalledTimes(1);
      const payoutCall = prisma.payout.createMany.mock.calls[0][0] as {
        data: Array<{ kind: string; amount: bigint }>;
      };
      expect(payoutCall.data).toHaveLength(2);
      expect(payoutCall.data.find((p) => p.kind === 'Fee')?.amount).toBe(
        280_000n,
      );
    });
  });

  // ── TournamentCancelled ────────────────────────────────────────────────────

  describe('TournamentCancelled', () => {
    // Handler only reads `tournament`; authority/cancelled_at are emitted but
    // ignored by the lean indexer. Stubs reflect the BorshCoder shape.
    const data: TournamentCancelledEvent = {
      tournament: TOURNAMENT_PDA,
      authority: ORGANIZER,
      cancelled_at: TX_TIMESTAMP_SEC,
    };

    it('happy-path → flips status to Cancelled', async () => {
      await asPrivate(service).handleTournamentCancelled(
        data,
        makeTx(),
        TX_SIGNATURE,
      );

      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.update.mock.calls[0][0] as {
        data: { status: string };
      };
      expect(call.data.status).toBe('Cancelled');
    });

    it('re-delivery → idempotent update', async () => {
      await asPrivate(service).handleTournamentCancelled(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      await asPrivate(service).handleTournamentCancelled(
        data,
        makeTx(),
        TX_SIGNATURE,
      );
      expect(prisma.tournament.update).toHaveBeenCalledTimes(2);
      expect(prisma.tournament.update.mock.calls[0][0]).toEqual(
        prisma.tournament.update.mock.calls[1][0],
      );
    });
  });

  // ── RefundIssued ───────────────────────────────────────────────────────────

  describe('RefundIssued', () => {
    const data = {
      tournament: TOURNAMENT_PDA,
      wallet: PLAYER_A,
      amount: '1000000',
    };

    it('happy-path participant refund → Payout(kind=Refund) + flips refundPaid', async () => {
      prisma.tournament.findUnique.mockResolvedValueOnce({
        address: TOURNAMENT_PDA,
        organizer: ORGANIZER,
        organizerDeposit: 0n,
      });

      await asPrivate(service).handleRefundIssued(data, TX_SIGNATURE);

      expect(prisma.payout.upsert).toHaveBeenCalledTimes(1);
      const upsertCall = prisma.payout.upsert.mock.calls[0][0] as {
        create: { kind: string; amount: bigint };
      };
      expect(upsertCall.create.kind).toBe('Refund');
      expect(upsertCall.create.amount).toBe(1_000_000n);

      expect(prisma.participant.updateMany).toHaveBeenCalledTimes(1);
      const flipCall = prisma.participant.updateMany.mock.calls[0][0] as {
        where: { tournamentAddress: string; wallet: string };
        data: { refundPaid: boolean };
      };
      expect(flipCall.data.refundPaid).toBe(true);
    });

    it('happy-path organizer-deposit refund → Payout(kind=OrganizerRefund), no participant flip', async () => {
      prisma.tournament.findUnique.mockResolvedValueOnce({
        address: TOURNAMENT_PDA,
        organizer: ORGANIZER,
        organizerDeposit: 500_000n,
      });

      const organizerRefund = { ...data, wallet: ORGANIZER, amount: '500000' };
      await asPrivate(service).handleRefundIssued(
        organizerRefund,
        TX_SIGNATURE,
      );

      const upsertCall = prisma.payout.upsert.mock.calls[0][0] as {
        create: { kind: string; amount: bigint; recipient: string };
      };
      expect(upsertCall.create.kind).toBe('OrganizerRefund');
      expect(upsertCall.create.recipient).toBe(ORGANIZER);
      expect(prisma.participant.updateMany).not.toHaveBeenCalled();
    });

    it('re-delivery → upsert keyed by (signature, recipient, kind) absorbs replay', async () => {
      prisma.tournament.findUnique.mockResolvedValue({
        address: TOURNAMENT_PDA,
        organizer: ORGANIZER,
        organizerDeposit: 0n,
      });

      await asPrivate(service).handleRefundIssued(data, TX_SIGNATURE);
      await asPrivate(service).handleRefundIssued(data, TX_SIGNATURE);

      expect(prisma.payout.upsert).toHaveBeenCalledTimes(2);
      const a = prisma.payout.upsert.mock.calls[0][0] as {
        where: {
          txSignature_recipient_kind: {
            txSignature: string;
            recipient: string;
            kind: string;
          };
        };
      };
      const b = prisma.payout.upsert.mock.calls[1][0] as {
        where: {
          txSignature_recipient_kind: {
            txSignature: string;
            recipient: string;
            kind: string;
          };
        };
      };
      expect(a.where.txSignature_recipient_kind).toEqual(
        b.where.txSignature_recipient_kind,
      );
    });

    it('skips when Tournament row missing (FK guard)', async () => {
      prisma.tournament.findUnique.mockResolvedValueOnce(null);
      await asPrivate(service).handleRefundIssued(data, TX_SIGNATURE);
      expect(prisma.payout.upsert).not.toHaveBeenCalled();
    });
  });

  // ── processBatch (dispatcher smoke) ────────────────────────────────────────

  describe('processBatch', () => {
    it('returns processed=0 events=0 for empty batch', async () => {
      const result = await service.processBatch([]);
      expect(result).toEqual({ processed: 0, events: 0 });
    });

    it('skips transactions with transactionError', async () => {
      const result = await service.processBatch([
        makeTx({ transactionError: 'oops' }),
      ]);
      expect(result).toEqual({ processed: 1, events: 0 });
      expect(prisma.tournament.upsert).not.toHaveBeenCalled();
    });

    it('skips transactions with meta.err', async () => {
      const result = await service.processBatch([
        makeTx({ meta: { err: { InstructionError: [0, 'Custom'] } } }),
      ]);
      expect(result).toEqual({ processed: 1, events: 0 });
    });

    it('skips transactions without logs', async () => {
      const result = await service.processBatch([
        makeTx({ meta: { logMessages: [] } }),
      ]);
      expect(result).toEqual({ processed: 1, events: 0 });
    });
  });
});
