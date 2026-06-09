import { Keypair, PublicKey } from '@solana/web3.js';

import { ReconciliationService } from './reconciliation.service';
import {
  ChainReaderService,
  DecodedTournament,
} from '../chain/chain-reader.service';
import { PrismaService } from '../prisma.service';
import { TournamentStatus } from '../generated/prisma';

// Real base58 32-byte pubkeys — ReconciliationService calls
// `new PublicKey(c.address)` and throws on invalid input, so the static
// "TourA1111..." fixtures don't work here (unlike the parser spec which
// only passes strings to `pubkeyToString`).
const PDA_A = Keypair.generate().publicKey.toBase58();
const PDA_B = Keypair.generate().publicKey.toBase58();
const PDA_C = Keypair.generate().publicKey.toBase58();
const CHAMPION_A = Keypair.generate().publicKey.toBase58();
const CHAMPION_B = Keypair.generate().publicKey.toBase58();

const CURRENT_SLOT = 350_000_000;
const FRESH_SLOT = BigInt(CURRENT_SLOT - 50); // < 150 slots away → not slotDrift
const STALE_SLOT = BigInt(CURRENT_SLOT - 500); // > 150 slots away → slotDrift

function chainAccount(
  overrides: {
    status?: string;
    champion?: PublicKey;
  } = {},
): DecodedTournament {
  return {
    organizer: PublicKey.default,
    name: 'TestCup',
    tokenMint: PublicKey.default,
    vault: PublicKey.default,
    entryFee: { toString: () => '0' },
    organizerDeposit: { toString: () => '0' },
    organizerDepositRefunded: false,
    maxParticipants: 8,
    bracketSize: 8,
    participantCount: 0,
    matchesInitialized: 0,
    matchesReported: 0,
    totalMatches: 7,
    registrationDeadline: { toString: () => '0' },
    createdAt: { toString: () => '0' },
    startedAt: { toString: () => '0' },
    completed_at: { toString: () => '0' },
    status: { [overrides.status ?? 'Active']: {} },
    payoutPreset: { Standard: {} },
    settlement_mode: { OrganizerOnly: {} },
    game: { Manual: {} },
    champion: overrides.champion ?? PublicKey.default,
    vrfRandomnessAccount: PublicKey.default,
    vrfCommitSlot: { toString: () => '0' },
    seedRevealed: false,
  };
}

function makePrismaMock(
  candidates: Array<{
    address: string;
    status: TournamentStatus;
    champion: string | null;
    chainSlotAtWrite: bigint;
    completedAt?: Date | null;
    completedTxSig?: string | null;
  }>,
  payoutOpts: {
    existing?: Array<{ tournamentAddress: string }>;
    created?: number;
  } = {},
) {
  return {
    tournament: {
      findMany: jest.fn().mockResolvedValue(candidates),
      update: jest.fn().mockResolvedValue(undefined),
      // M-4: freshness-only watermark bumps are flushed in one batched
      // updateMany. Default count mirrors the candidate set size.
      updateMany: jest.fn().mockResolvedValue({ count: candidates.length }),
    },
    payout: {
      findMany: jest.fn().mockResolvedValue(payoutOpts.existing ?? []),
      createMany: jest
        .fn()
        .mockResolvedValue({ count: payoutOpts.created ?? 0 }),
    },
  };
}

function makeChainReader(
  decoded: Array<DecodedTournament | null>,
  slot: number = CURRENT_SLOT,
  completionPayouts: {
    txSignature: string;
    payouts: Array<{
      recipient: string;
      amount: bigint;
      kind: string;
      placement: number | null;
    }>;
  } | null = null,
) {
  return {
    fetchTournaments: jest.fn().mockResolvedValue(decoded),
    getSlot: jest.fn().mockResolvedValue(slot),
    fetchCompletionPayouts: jest.fn().mockResolvedValue(completionPayouts),
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;
type ChainMock = ReturnType<typeof makeChainReader>;

function makeService(prisma: PrismaMock, chain: ChainMock) {
  return new ReconciliationService(
    prisma as unknown as PrismaService,
    chain as unknown as ChainReaderService,
  );
}

describe('ReconciliationService', () => {
  describe('no-op cases', () => {
    it('returns scanned=0 when no candidates', async () => {
      const prisma = makePrismaMock([]);
      const chain = makeChainReader([]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      const status = service.getStatus();
      expect(status.lastReconcileScanned).toBe(0);
      expect(status.lastReconcileTouched).toBe(0);
      expect(status.lastReconcileError).toBeNull();
      expect(prisma.tournament.update).not.toHaveBeenCalled();
    });

    it('does not touch rows when chain and DB agree (fresh slot)', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([chainAccount({ status: 'active' })]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(prisma.tournament.update).not.toHaveBeenCalled();
      expect(service.getStatus().lastReconcileTouched).toBe(0);
    });

    it('skips rows when chain account fetch returns null', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([null]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(prisma.tournament.update).not.toHaveBeenCalled();
    });
  });

  describe('drift cases', () => {
    it('status drift: chain=Completed, DB=Active → patches status + bumps slot', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([
        chainAccount({
          status: 'completed',
          champion: new PublicKey(CHAMPION_A),
        }),
      ]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.update.mock.calls[0][0] as {
        where: { address: string };
        data: {
          status?: TournamentStatus;
          champion?: string | null;
          chainSlotAtWrite: bigint;
        };
      };
      expect(call.where.address).toBe(PDA_A);
      expect(call.data.status).toBe(TournamentStatus.Completed);
      expect(call.data.champion).toBe(CHAMPION_A);
      expect(call.data.chainSlotAtWrite).toBe(BigInt(CURRENT_SLOT));
      expect(service.getStatus().lastReconcileTouched).toBe(1);
    });

    it('champion drift only: chain has champion, DB does not', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Completed,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([
        chainAccount({
          status: 'completed',
          champion: new PublicKey(CHAMPION_B),
        }),
      ]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.update.mock.calls[0][0] as {
        data: {
          status?: TournamentStatus;
          champion?: string | null;
        };
      };
      expect(call.data.champion).toBe(CHAMPION_B);
      expect(call.data.status).toBeUndefined(); // status didn't drift
    });

    it('slot drift only (M-4): batched freshness bump, no per-row update', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: STALE_SLOT,
        },
      ]);
      const chain = makeChainReader([chainAccount({ status: 'active' })]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      // Freshness-only goes through the batched updateMany, not a per-row update.
      expect(prisma.tournament.update).not.toHaveBeenCalled();
      expect(prisma.tournament.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.updateMany.mock.calls[0][0] as {
        where: { address: { in: string[] } };
        data: { chainSlotAtWrite: bigint };
      };
      expect(call.where.address.in).toEqual([PDA_A]);
      expect(call.data.chainSlotAtWrite).toBe(BigInt(CURRENT_SLOT));
      // It is not drift — touched stays 0, freshnessBumped reflects the bump.
      const status = service.getStatus();
      expect(status.lastReconcileTouched).toBe(0);
      expect(status.lastReconcileFreshnessBumped).toBe(1);
    });

    it('cancelled drift: chain=Cancelled, DB=Active', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([chainAccount({ status: 'cancelled' })]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      const call = prisma.tournament.update.mock.calls[0][0] as {
        data: { status?: TournamentStatus };
      };
      expect(call.data.status).toBe(TournamentStatus.Cancelled);
    });

    it('unknown chain status variant → status not patched (defensive)', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: STALE_SLOT,
        },
      ]);
      const chain = makeChainReader([
        chainAccount({ status: 'futureUnknownVariant' }),
      ]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      // Unknown variant → no content drift; the stale slot is handled by the
      // batched freshness bump, never a per-row status patch.
      expect(prisma.tournament.update).not.toHaveBeenCalled();
      expect(prisma.tournament.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.updateMany.mock.calls[0][0] as {
        where: { address: { in: string[] } };
        data: { status?: TournamentStatus; chainSlotAtWrite: bigint };
      };
      expect(call.where.address.in).toEqual([PDA_A]);
      expect(call.data.status).toBeUndefined();
      expect(call.data.chainSlotAtWrite).toBe(BigInt(CURRENT_SLOT));
    });
  });

  describe('multi-row batch', () => {
    it('patches only the drifted rows out of mixed batch', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
        {
          address: PDA_B,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
        {
          address: PDA_C,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: FRESH_SLOT,
        },
      ]);
      const chain = makeChainReader([
        chainAccount({ status: 'active' }), // A: agree
        chainAccount({
          status: 'completed',
          champion: new PublicKey(CHAMPION_A),
        }), // B: drift
        null, // C: fetch failed, skip
      ]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(prisma.tournament.update).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.update.mock.calls[0][0] as {
        where: { address: string };
      };
      expect(call.where.address).toBe(PDA_B);
      // A is fresh (no drift, no stale slot) → no freshness bump either.
      expect(prisma.tournament.updateMany).not.toHaveBeenCalled();
      expect(service.getStatus().lastReconcileScanned).toBe(3);
      expect(service.getStatus().lastReconcileTouched).toBe(1);
      expect(service.getStatus().lastReconcileFreshnessBumped).toBe(0);
    });

    it('M-4: collapses many stale-slot rows into one batched updateMany', async () => {
      const prisma = makePrismaMock([
        {
          address: PDA_A,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: STALE_SLOT,
        },
        {
          address: PDA_B,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: STALE_SLOT,
        },
        {
          address: PDA_C,
          status: TournamentStatus.Active,
          champion: null,
          chainSlotAtWrite: STALE_SLOT,
        },
      ]);
      const chain = makeChainReader([
        chainAccount({ status: 'active' }),
        chainAccount({ status: 'active' }),
        chainAccount({ status: 'active' }),
      ]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      // Three stale-but-clean rows → zero per-row updates, one bulk bump.
      expect(prisma.tournament.update).not.toHaveBeenCalled();
      expect(prisma.tournament.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.tournament.updateMany.mock.calls[0][0] as {
        where: { address: { in: string[] } };
        data: { chainSlotAtWrite: bigint };
      };
      expect(call.where.address.in).toEqual([PDA_A, PDA_B, PDA_C]);
      expect(call.data.chainSlotAtWrite).toBe(BigInt(CURRENT_SLOT));
      expect(service.getStatus().lastReconcileTouched).toBe(0);
      expect(service.getStatus().lastReconcileFreshnessBumped).toBe(3);
    });
  });

  describe('payout backfill (M-2)', () => {
    it('reconstructs payouts for a Completed tournament with no payout rows', async () => {
      const prisma = makePrismaMock(
        [
          {
            address: PDA_A,
            status: TournamentStatus.Completed,
            champion: null,
            chainSlotAtWrite: FRESH_SLOT,
            completedAt: new Date(),
            completedTxSig: 'completeSig123',
          },
        ],
        { existing: [], created: 2 },
      );
      const chain = makeChainReader(
        [chainAccount({ status: 'completed' })],
        CURRENT_SLOT,
        {
          txSignature: 'completeSig123',
          payouts: [
            {
              recipient: CHAMPION_A,
              amount: 900n,
              kind: 'Prize',
              placement: 1,
            },
            {
              recipient: CHAMPION_B,
              amount: 100n,
              kind: 'Fee',
              placement: null,
            },
          ],
        },
      );
      const service = makeService(prisma, chain);

      await service.reconcile();

      // No status/champion/slot drift → no tournament.update, only payout backfill.
      expect(prisma.tournament.update).not.toHaveBeenCalled();
      expect(chain.fetchCompletionPayouts).toHaveBeenCalledTimes(1);
      const [pdaArg, sigArg] = chain.fetchCompletionPayouts.mock.calls[0];
      expect((pdaArg as PublicKey).toBase58()).toBe(PDA_A);
      expect(sigArg).toBe('completeSig123');
      expect(prisma.payout.createMany).toHaveBeenCalledTimes(1);
      const createArg = prisma.payout.createMany.mock.calls[0][0] as {
        data: Array<{ tournamentAddress: string; txSignature: string }>;
        skipDuplicates: boolean;
      };
      expect(createArg.data).toHaveLength(2);
      expect(createArg.data[0].tournamentAddress).toBe(PDA_A);
      expect(createArg.skipDuplicates).toBe(true);
      expect(service.getStatus().lastReconcilePayoutsBackfilled).toBe(1);
    });

    it('skips backfill when the Completed tournament already has payout rows', async () => {
      const prisma = makePrismaMock(
        [
          {
            address: PDA_A,
            status: TournamentStatus.Completed,
            champion: null,
            chainSlotAtWrite: FRESH_SLOT,
            completedAt: new Date(),
            completedTxSig: 'completeSig123',
          },
        ],
        { existing: [{ tournamentAddress: PDA_A }] },
      );
      const chain = makeChainReader([chainAccount({ status: 'completed' })]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(chain.fetchCompletionPayouts).not.toHaveBeenCalled();
      expect(prisma.payout.createMany).not.toHaveBeenCalled();
      expect(service.getStatus().lastReconcilePayoutsBackfilled).toBe(0);
    });

    it('no-op (no error) when no completion event is reconstructable', async () => {
      const prisma = makePrismaMock(
        [
          {
            address: PDA_A,
            status: TournamentStatus.Completed,
            champion: null,
            chainSlotAtWrite: FRESH_SLOT,
            completedAt: new Date(),
            completedTxSig: null,
          },
        ],
        { existing: [] },
      );
      // fetchCompletionPayouts defaults to null → unrecoverable, skip.
      const chain = makeChainReader([chainAccount({ status: 'completed' })]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(chain.fetchCompletionPayouts).toHaveBeenCalledTimes(1);
      expect(prisma.payout.createMany).not.toHaveBeenCalled();
      expect(service.getStatus().lastReconcilePayoutsBackfilled).toBe(0);
      expect(service.getStatus().lastReconcileError).toBeNull();
    });
  });

  describe('error handling', () => {
    it('captures error to lastReconcileError without throwing', async () => {
      const prisma = makePrismaMock([]);
      prisma.tournament.findMany.mockRejectedValueOnce(new Error('db down'));
      const chain = makeChainReader([]);
      const service = makeService(prisma, chain);

      await service.reconcile();

      expect(service.getStatus().lastReconcileError).toBe('db down');
    });
  });

  describe('getStatus', () => {
    it('returns null lastReconcileAt before first run', () => {
      const service = makeService(makePrismaMock([]), makeChainReader([]));
      expect(service.getStatus()).toEqual({
        lastReconcileAt: null,
        lastReconcileScanned: 0,
        lastReconcileTouched: 0,
        lastReconcilePayoutsBackfilled: 0,
        lastReconcileFreshnessBumped: 0,
        lastReconcileError: null,
      });
    });

    it('populates lastReconcileAt as ISO string after run', async () => {
      const prisma = makePrismaMock([]);
      const chain = makeChainReader([]);
      const service = makeService(prisma, chain);

      const before = Date.now();
      await service.reconcile();
      const status = service.getStatus();

      expect(status.lastReconcileAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
      expect(
        new Date(status.lastReconcileAt!).getTime(),
      ).toBeGreaterThanOrEqual(before);
    });
  });
});
