import { MatchStatus, ProposalSource } from '../generated/prisma';
import { OracleRelayerDriver } from './oracle-relayer.driver';

// Mock the linked SDK so the driver's scan→propose logic runs offline: no RPC,
// no signer crypto. `proposeResultOracle` becomes an observable stub.
jest.mock('@bracketchain/sdk', () => ({
  BracketChainClient: jest
    .fn()
    .mockImplementation(() => ({ signer: { address: 'ClaimPayer11111' } })),
  proposeResultOracle: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require('@bracketchain/sdk') as {
  BracketChainClient: jest.Mock;
  proposeResultOracle: jest.Mock;
};

const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';
const FEED_A = 'Feed1111111111111111111111111111111111111111';
const FEED_B = 'Feed2222222222222222222222222222222222222222';

type MatchRow = {
  tournamentAddress: string;
  bracket: number;
  round: number;
  matchIndex: number;
  switchboardFeed: string | null;
};

function makePrismaMock(due: MatchRow[]) {
  return {
    match: { findMany: jest.fn().mockResolvedValue(due) },
  };
}

const MATCH_A: MatchRow = {
  tournamentAddress: TOURNAMENT_PDA,
  bracket: 0,
  round: 0,
  matchIndex: 0,
  switchboardFeed: FEED_A,
};
const MATCH_B: MatchRow = {
  tournamentAddress: TOURNAMENT_PDA,
  bracket: 0,
  round: 0,
  matchIndex: 1,
  switchboardFeed: FEED_B,
};

function makeDriver(prisma: ReturnType<typeof makePrismaMock>): OracleRelayerDriver {
  process.env.PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';
  const keychain = { getSigner: jest.fn().mockResolvedValue({ address: 'signer' }) };
  return new OracleRelayerDriver(keychain as never, prisma as never);
}

type DriverPrivate = { tick: () => Promise<void>; drive: () => Promise<void> };
const asPrivate = (d: OracleRelayerDriver) => d as unknown as DriverPrivate;

describe('OracleRelayerDriver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.proposeResultOracle.mockResolvedValue({ txSignature: 'tx' });
  });

  describe('scan query', () => {
    it('targets only Active, source=None, feed-bound matches', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();

      const arg = prisma.match.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({
        status: MatchStatus.Active,
        proposalSource: ProposalSource.None,
        switchboardFeed: { not: null },
      });
      expect(arg.take).toBe(25);
      expect(arg.orderBy).toEqual({ committedAt: 'asc' });
    });

    it('no due matches → builds no client, proposes nothing', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.BracketChainClient).not.toHaveBeenCalled();
      expect(sdk.proposeResultOracle).not.toHaveBeenCalled();
    });
  });

  describe('proposeOne', () => {
    it('passes through tournament/coords/feed', async () => {
      const prisma = makePrismaMock([MATCH_A]);
      await asPrivate(makeDriver(prisma)).tick();

      expect(sdk.proposeResultOracle).toHaveBeenCalledTimes(1);
      const arg = sdk.proposeResultOracle.mock.calls[0][1];
      expect(arg).toEqual({
        tournamentPda: TOURNAMENT_PDA,
        bracket: 0,
        round: 0,
        matchIndex: 0,
        switchboardFeed: FEED_A,
      });
    });

    it('per-match error isolation → one failure does not abort the tick', async () => {
      sdk.proposeResultOracle
        .mockRejectedValueOnce(new Error('feed not fresh'))
        .mockResolvedValueOnce({ txSignature: 'tx2' });
      const prisma = makePrismaMock([MATCH_A, MATCH_B]);

      await asPrivate(makeDriver(prisma)).tick(); // must not throw

      // Both attempts made; first failed cleanly, second succeeded.
      expect(sdk.proposeResultOracle).toHaveBeenCalledTimes(2);
      expect(sdk.proposeResultOracle.mock.calls[1][1].matchIndex).toBe(1);
    });
  });

  describe('production guard (via drive)', () => {
    afterEach(() => {
      delete process.env.PERMISSIONLESS_DRIVERS_ENABLED;
      delete process.env.PERMISSIONLESS_ORACLE_RELAYER_ENABLED;
    });

    it('both flags unset → tick never runs (default-off)', async () => {
      const prisma = makePrismaMock([MATCH_A]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).not.toHaveBeenCalled();
    });

    it('master switch on but driver flag off → still off', async () => {
      process.env.PERMISSIONLESS_DRIVERS_ENABLED = 'true';
      const prisma = makePrismaMock([MATCH_A]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).not.toHaveBeenCalled();
    });

    it('both flags on → tick runs', async () => {
      process.env.PERMISSIONLESS_DRIVERS_ENABLED = 'true';
      process.env.PERMISSIONLESS_ORACLE_RELAYER_ENABLED = 'true';
      const prisma = makePrismaMock([MATCH_A]);
      await asPrivate(makeDriver(prisma)).drive();
      expect(prisma.match.findMany).toHaveBeenCalledTimes(1);
      expect(sdk.proposeResultOracle).toHaveBeenCalledTimes(1);
    });
  });
});
