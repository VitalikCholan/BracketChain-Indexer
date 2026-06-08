import { TournamentStatus } from '../generated/prisma';
import { CloseTerminalDriver } from './close-terminal.driver';

// Mock the linked SDK so the driver's scan→close logic runs offline: no RPC,
// no signer crypto. The query + close stubs become observable.
jest.mock('@bracketchain/sdk', () => ({
  BracketChainClient: jest
    .fn()
    .mockImplementation(() => ({ signer: { address: 'CleanupPayer11111' } })),
  getTournament: jest.fn(),
  listParticipants: jest.fn(),
  getAllMatches: jest.fn(),
  closeTournament: jest.fn(),
}));

const sdk = require('@bracketchain/sdk') as {
  BracketChainClient: jest.Mock;
  getTournament: jest.Mock;
  listParticipants: jest.Mock;
  getAllMatches: jest.Mock;
  closeTournament: jest.Mock;
};

const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';
const PART_A = 'Part1111111111111111111111111111111111111111';
const MATCH_A = 'Mtch1111111111111111111111111111111111111111';

function makePrismaMock(due: Array<{ address: string }>) {
  return {
    tournament: { findMany: jest.fn().mockResolvedValue(due) },
  };
}

function makeDriver(
  prisma: ReturnType<typeof makePrismaMock>,
): CloseTerminalDriver {
  process.env.PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';
  const keychain = {
    getSigner: jest.fn().mockResolvedValue({ address: 'signer' }),
  };
  return new CloseTerminalDriver(keychain as never, prisma as never);
}

type DriverPrivate = { tick: () => Promise<void> };
const asPrivate = (d: CloseTerminalDriver) => d as unknown as DriverPrivate;

describe('CloseTerminalDriver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.getTournament.mockResolvedValue({ address: TOURNAMENT_PDA });
    sdk.listParticipants.mockResolvedValue([{ address: PART_A, account: {} }]);
    sdk.getAllMatches.mockResolvedValue([{ address: MATCH_A, account: {} }]);
    sdk.closeTournament.mockResolvedValue({
      txSignatures: ['tx1', 'tx2'],
      childrenSubmitted: 2,
      rootClosed: true,
    });
  });

  describe('scan query', () => {
    it('targets terminal status past the 7-day completedAt cutoff', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();

      const arg = prisma.tournament.findMany.mock.calls[0][0];
      expect(arg.where.status).toEqual({
        in: [TournamentStatus.Completed, TournamentStatus.Cancelled],
      });
      expect(arg.where.completedAt.lte).toBeInstanceOf(Date);
      // ~7 days in the past.
      const ageMs = Date.now() - (arg.where.completedAt.lte as Date).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 5_000);
      expect(arg.take).toBe(5);
      expect(arg.orderBy).toEqual({ completedAt: 'asc' });
    });

    it('no due tournaments → builds no client, closes nothing', async () => {
      const prisma = makePrismaMock([]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.BracketChainClient).not.toHaveBeenCalled();
      expect(sdk.closeTournament).not.toHaveBeenCalled();
    });
  });

  describe('closeOne', () => {
    it('gathers participant + match PDAs and closes with closeRoot=true', async () => {
      const prisma = makePrismaMock([{ address: TOURNAMENT_PDA }]);
      await asPrivate(makeDriver(prisma)).tick();

      expect(sdk.closeTournament).toHaveBeenCalledTimes(1);
      const arg = sdk.closeTournament.mock.calls[0][1];
      expect(arg).toMatchObject({
        tournamentPda: TOURNAMENT_PDA,
        closeRoot: true,
      });
      expect(arg.childPdas).toEqual([PART_A, MATCH_A]);
    });

    it('already-closed tournament (getTournament throws) → skipped, no close', async () => {
      sdk.getTournament.mockRejectedValue(new Error('account not found'));
      const prisma = makePrismaMock([{ address: TOURNAMENT_PDA }]);
      await asPrivate(makeDriver(prisma)).tick();
      expect(sdk.closeTournament).not.toHaveBeenCalled();
    });
  });
});
