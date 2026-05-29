import { TournamentStatus } from '../generated/prisma';
import { PartialRefundDriver } from './partial-refund.driver';

jest.mock('@bracketchain/sdk', () => ({
  BracketChainClient: jest
    .fn()
    .mockImplementation(() => ({ signer: { address: 'RefundPayer11111' } })),
  getTournament: jest.fn(),
  partialRefundChunk: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require('@bracketchain/sdk') as {
  BracketChainClient: jest.Mock;
  getTournament: jest.Mock;
  partialRefundChunk: jest.Mock;
};

const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';

function makePrismaMock(due: Array<{ address: string }>) {
  return { tournament: { findMany: jest.fn().mockResolvedValue(due) } };
}
function makeDriver(prisma: ReturnType<typeof makePrismaMock>): PartialRefundDriver {
  process.env.PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';
  const keychain = { getSigner: jest.fn().mockResolvedValue({ address: 'signer' }) };
  return new PartialRefundDriver(keychain as never, prisma as never);
}
type DriverPrivate = { tick: () => Promise<void> };
const asPrivate = (d: PartialRefundDriver) => d as unknown as DriverPrivate;

describe('PartialRefundDriver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.getTournament.mockResolvedValue({ address: TOURNAMENT_PDA });
    sdk.partialRefundChunk.mockResolvedValue({
      txSignatures: ['tx1'],
      refundsSubmitted: 4,
    });
  });

  it('targets only PartialCancelled tournaments', async () => {
    const prisma = makePrismaMock([]);
    await asPrivate(makeDriver(prisma)).tick();
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: TournamentStatus.PartialCancelled });
    expect(arg.take).toBe(5);
  });

  it('no due tournaments → builds no client, refunds nothing', async () => {
    const prisma = makePrismaMock([]);
    await asPrivate(makeDriver(prisma)).tick();
    expect(sdk.BracketChainClient).not.toHaveBeenCalled();
    expect(sdk.partialRefundChunk).not.toHaveBeenCalled();
  });

  it('drives partialRefundChunk for a due tournament', async () => {
    const prisma = makePrismaMock([{ address: TOURNAMENT_PDA }]);
    await asPrivate(makeDriver(prisma)).tick();
    expect(sdk.partialRefundChunk).toHaveBeenCalledTimes(1);
    expect(sdk.partialRefundChunk.mock.calls[0][1]).toMatchObject({
      tournamentPda: TOURNAMENT_PDA,
    });
  });

  it('already-closed tournament (getTournament throws) → skipped', async () => {
    sdk.getTournament.mockRejectedValue(new Error('account not found'));
    const prisma = makePrismaMock([{ address: TOURNAMENT_PDA }]);
    await asPrivate(makeDriver(prisma)).tick();
    expect(sdk.partialRefundChunk).not.toHaveBeenCalled();
  });
});
