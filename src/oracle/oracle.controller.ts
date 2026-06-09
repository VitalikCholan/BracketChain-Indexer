import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { PrismaService } from '../prisma.service';
import { OpenDotaService } from './opendota.service';

const HEX_RE = /^[0-9a-f]+$/;

function requireHexParam(value: unknown, bytes: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length !== bytes * 2 ||
    !HEX_RE.test(value)
  ) {
    throw new BadRequestException(
      `${name} must be ${bytes * 2} lowercase-hex chars (${bytes} bytes)`,
    );
  }
  return value;
}

@Controller('oracle')
export class OracleController {
  constructor(
    private readonly identity: IdentityService,
    private readonly prisma: PrismaService,
    private readonly openDota: OpenDotaService,
  ) {}

  @Get('dota-winner')
  async dotaWinner(
    @Query('lobby') lobbyRaw: unknown,
    @Query('a') aRaw: unknown,
    @Query('b') bRaw: unknown,
    @Query('source') sourceRaw: unknown,
    @Headers('x-oracle-secret') secret?: string,
  ): Promise<{ winner: 0 | 1 }> {
    const requiredSecret = process.env.ORACLE_ENDPOINT_SECRET;
    if (requiredSecret && secret !== requiredSecret) {
      throw new UnauthorizedException();
    }

    const lobby = requireHexParam(lobbyRaw, 16, 'lobby');
    const a = requireHexParam(aRaw, 32, 'a');
    const b = requireHexParam(bRaw, 32, 'b');
    if (sourceRaw !== undefined && sourceRaw !== 'opendota') {
      const shown = typeof sourceRaw === 'string' ? sourceRaw : '<non-string>';
      throw new BadRequestException(
        `unsupported source "${shown}" — Phase 1.5 supports "opendota"`,
      );
    }

    const [steamA, steamB] = await Promise.all([
      this.identity.resolveSteamId(a),
      this.identity.resolveSteamId(b),
    ]);
    if (!steamA || !steamB) {
      throw new NotFoundException('identity hash not linked');
    }

    const match = await this.prisma.match.findFirst({
      where: { lobbyId: Buffer.from(lobby, 'hex') },
      select: { committedAt: true },
    });
    if (!match?.committedAt) {
      throw new NotFoundException('lobby not committed');
    }
    const committedAtUnix = Math.floor(match.committedAt.getTime() / 1000);

    const winner = await this.openDota.resolveWinner(
      steamA,
      steamB,
      committedAtUnix,
    );
    if (winner === null) {
      throw new NotFoundException('match result not available yet');
    }
    return { winner };
  }

  @Post('crossbar-store')
  async crossbarStore(@Body() body: unknown): Promise<unknown> {
    const crossbar = (
      process.env.CROSSBAR_URL ?? 'https://crossbar.switchboard.xyz'
    ).replace(/\/+$/, '');

    let res: Response;
    try {
      res = await fetch(`${crossbar}/v2/store`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new BadGatewayException(
        `crossbar unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(`crossbar /v2/store -> ${res.status}`);
    }
    return res.json();
  }
}
