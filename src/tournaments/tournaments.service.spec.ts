import { TournamentsService } from './tournaments.service';

const ORGANIZER = 'OrganizerWalletBase58111111111111111111111111';
const NAME = 'TestCup';
const TOURNAMENT_PDA = 'Tour1111111111111111111111111111111111111111';

function makePrismaMock() {
  return {
    tournament: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    participant: { findMany: jest.fn() },
    match: { findMany: jest.fn() },
    payout: { findMany: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeService(prisma: PrismaMock) {
  return new TournamentsService(prisma as never);
}

describe('TournamentsService.checkName', () => {
  it('returns { taken: false } when no row matches', async () => {
    const prisma = makePrismaMock();
    prisma.tournament.findFirst.mockResolvedValue(null);
    const service = makeService(prisma);

    const result = await service.checkName(ORGANIZER, NAME);

    expect(result).toEqual({ taken: false });
    expect(prisma.tournament.findFirst).toHaveBeenCalledWith({
      where: { organizer: ORGANIZER, name: NAME },
      select: { address: true },
    });
  });

  it('returns { taken: true, address } when row exists', async () => {
    const prisma = makePrismaMock();
    prisma.tournament.findFirst.mockResolvedValue({
      address: TOURNAMENT_PDA,
    });
    const service = makeService(prisma);

    const result = await service.checkName(ORGANIZER, NAME);

    expect(result).toEqual({ taken: true, address: TOURNAMENT_PDA });
  });

  it('does not leak the address field when no match', async () => {
    const prisma = makePrismaMock();
    prisma.tournament.findFirst.mockResolvedValue(null);
    const service = makeService(prisma);

    const result = await service.checkName(ORGANIZER, NAME);
    expect(result).not.toHaveProperty('address');
  });
});
