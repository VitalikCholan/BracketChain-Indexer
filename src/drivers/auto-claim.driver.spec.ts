import { MatchStatus, ProposalSource } from '../generated/prisma';
import { AutoClaimDriver } from './auto-claim.driver';

// Mock the linked SDK so the driver's scan→claim logic runs offline: no RPC,
// no signer crypto. `claimResult`/`getTournament` become observable stubs;
// `PayoutPreset` is a plain object whose identity the driver compares against
// the (also-stubbed) `getTournament` result.
jest.mock('@bracketchain/sdk', () => ({
  BracketChainClient: jest
    .fn()
    .mockImplementation(() => ({ signer: { address: 'ClaimPayer11111' } })),
  claimResult: jest.fn(),
  getTournament: jest.fn(),
  PayoutPreset: { WinnerTakesAll: 'WinnerTakesAll', Standard: 'Standard', Deep: 'Deep' },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require('@bracketchain/sdk') as {
  BracketChainClient: jest.Mock;
  claimResult: jest.Mock;
  getTournament: jest.Mock;
  PayoutPreset: { WinnerTakesAll: string; Standard: string; Deep: string };
};

const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';
const PLAYER_A = 'PlayerA1111111111111111111111111111111111111';

type MatchRow = {
  tournamentAddress: string;
  bracket: number;
  round: number;
  matchIndex: number;
  proposedWinner: string | null;
};

function makePrismaMock(due: MatchRow[]) {
  return {
    match: { findMany: jest.fn().mockResolvedValue(due) },
  };
}

/** bracketSize 4 → maxRound 2: round 1 / matchIndex 0 is the final. */
const NON_FINAL: MatchRow = {
  tournamentAddress: TOURNAMENT_PDA,
  bracket: 0,
  round: 0,
  matchIndex: 1,
  proposedWinner: PLAYER_A,
};
const FINAL: MatchRow = {
  tournamentAddress: TOURNAMENT_PDA,
  bracket: 0,
  round: 1,
  matchIndex: 0,
  proposedWinner: PLAYER_A,
};

function makeDriver(prisma: ReturnType<typeof makePrismaMock>): AutoClaimDriver {
  process.env.PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';
  const keychain = { getSigner: jest.fn().mockResolvedValue({ address: 'signer' }) };
  return new AutoClaimDriver(keychain as never, prisma as never);
}

type DriverPrivate = { tick: () => Promise<void>; drive: () => Promise<void> };
const asPrivate = (d: AutoClaimDriver) => d as unknown as DriverPrivate;

describe('AutoClaimDriver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.claimResult.mockResolvedValue({ txSignature: 'tx', isFinal: false });
  });

  describe('scan query', () => {
    it('targets only PendingConfirmation, !disputed, sourced, past-deadline matches', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();

      const arg = prisma.match.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({
        status: MatchStatus.PendingConfirmation,
        disputed: false,
        proposalSource: { not: ProposalSource.None },
      });
      expect(arg.where.claimDeadline.lte).toBeInstanceOf(Date);
      expect(arg.take).toBe(25);
      expect(arg.orderBy).toEqual({ claimDeadline: 'asc' });
    });

    it('no due matches → builds no client, claims nothing', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.BracketChainClient).not.toHaveBeenCalled();
      expect(sdk.claimResult).not.toHaveBeenCalled();
    });
  });

  describe('claimOne', () => {
    it('non-final → claims with no placements', async () => {
      sdk.getTournament.mockResolvedValue({ bracketSize: 4, payoutPreset: 'Standard' });
      const prisma = makePrismaMock([NON_FINAL]);
      await asPrivate(makeDriver(prisma)).tick();

      expect(sdk.claimResult).toHaveBeenCalledTimes(1);
      const arg = sdk.claimResult.mock.calls[0][1];
      expect(arg).toMatchObject({ round: 0, matchIndex: 1, bracket: 0 });
      expect(arg.placements).toBeUndefined();
    });

    it('WinnerTakesAll final → claims with placements=[proposedWinner]', async () => {
      sdk.getTournament.mockResolvedValue({
        bracketSize: 4,
        payoutPreset: sdk.PayoutPreset.WinnerTakesAll,
      });
      const prisma = makePrismaMock([FINAL]);
      await asPrivate(makeDriver(prisma)).tick();

      expect(sdk.claimResult).toHaveBeenCalledTimes(1);
      expect(sdk.claimResult.mock.calls[0][1].placements).toEqual([PLAYER_A]);
    });

    it('non-WTA final → skipped (organizer-adjudicated 3rd place, by design)', async () => {
      sdk.getTournament.mockResolvedValue({ bracketSize: 4, payoutPreset: 'Standard' });
      const prisma = makePrismaMock([FINAL]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.claimResult).not.toHaveBeenCalled();
    });

    it('WTA final missing proposedWinner in cache → skipped', async () => {
      sdk.getTournament.mockResolvedValue({
        bracketSize: 4,
        payoutPreset: sdk.PayoutPreset.WinnerTakesAll,
      });
      const prisma = makePrismaMock([{ ...FINAL, proposedWinner: null }]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.claimResult).not.toHaveBeenCalled();
    });

    it('per-match error isolation → one failure does not abort the tick', async () => {
      sdk.getTournament
        .mockRejectedValueOnce(new Error('stale row'))
        .mockResolvedValueOnce({ bracketSize: 4, payoutPreset: 'Standard' });
      const second = { ...NON_FINAL, matchIndex: 2 };
      const prisma = makePrismaMock([NON_FINAL, second]);

      await asPrivate(makeDriver(prisma)).tick(); // must not throw

      // First match threw in getTournament → no claim; second still claimed.
      expect(sdk.claimResult).toHaveBeenCalledTimes(1);
      expect(sdk.claimResult.mock.calls[0][1].matchIndex).toBe(2);
    });
  });

  describe('production guard (via drive)', () => {
    afterEach(() => {
      delete process.env.PERMISSIONLESS_DRIVERS_ENABLED;
      delete process.env.PERMISSIONLESS_AUTO_CLAIM_ENABLED;
    });

    it('both flags unset → tick never runs (default-off)', async () => {
      const prisma = makePrismaMock([NON_FINAL]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).not.toHaveBeenCalled();
    });

    it('master switch on but driver flag off → still off', async () => {
      process.env.PERMISSIONLESS_DRIVERS_ENABLED = 'true';
      const prisma = makePrismaMock([NON_FINAL]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).not.toHaveBeenCalled();
    });

    it('both flags on → tick runs', async () => {
      process.env.PERMISSIONLESS_DRIVERS_ENABLED = 'true';
      process.env.PERMISSIONLESS_AUTO_CLAIM_ENABLED = 'true';
      sdk.getTournament.mockResolvedValue({ bracketSize: 4, payoutPreset: 'Standard' });
      const prisma = makePrismaMock([NON_FINAL]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
      expect(sdk.claimResult).toHaveBeenCalledTimes(1);
    });
  });
});
