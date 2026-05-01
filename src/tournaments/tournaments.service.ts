import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Payout, Tournament, TournamentStatus } from '../generated/prisma';

@Injectable()
export class TournamentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { status?: TournamentStatus; limit?: number }): Promise<Tournament[]> {
    const { status, limit = 20 } = params;
    return this.prisma.tournament.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getPayouts(address: string): Promise<Payout[]> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!tournament) {
      throw new NotFoundException(`Tournament ${address} not found`);
    }
    return this.prisma.payout.findMany({
      where: { tournamentAddress: address },
      orderBy: [{ kind: 'asc' }, { placement: 'asc' }],
    });
  }
}
