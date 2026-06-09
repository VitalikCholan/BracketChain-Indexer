import { Controller, Get, Param, Query } from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { ListTournamentsQueryDto } from './dto/list-tournaments.dto';
import { CheckNameQueryDto } from './dto/check-name.dto';

// JSON.stringify can't serialize BigInt — convert to string in API responses.
// Prisma `Bytes` columns surface as Uint8Array; serialize as lowercase hex
// (consistent with how the on-chain values are displayed) so the frontend
// can render them without inspecting a numeric-keyed object.
type Serialized<T> = {
  [K in keyof T]: T[K] extends bigint
    ? string
    : T[K] extends bigint | null
      ? string | null
      : T[K] extends Uint8Array
        ? string
        : T[K] extends Uint8Array | null
          ? string | null
          : T[K];
};

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function serializeRow<T extends Record<string, unknown>>(
  row: T,
): Serialized<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Uint8Array) out[k] = bytesToHex(v);
    else out[k] = v;
  }
  return out as Serialized<T>;
}

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly service: TournamentsService) {}

  @Get()
  async list(@Query() query: ListTournamentsQueryDto) {
    const rows = await this.service.list({
      status: query.status,
      limit: query.limit,
    });
    return rows.map(serializeRow);
  }

  /**
   * Must be declared BEFORE `:address` — Nest routes resolve top-to-bottom
   * and `:address` would otherwise swallow `check-name` as a literal PDA.
   */
  @Get('check-name')
  async checkName(@Query() query: CheckNameQueryDto) {
    return this.service.checkName(query.organizer, query.name);
  }

  @Get(':address')
  async getOne(@Param('address') address: string) {
    const row = await this.service.getOne(address);
    return serializeRow(row);
  }

  @Get(':address/payouts')
  async payouts(@Param('address') address: string) {
    const rows = await this.service.getPayouts(address);
    return rows.map(serializeRow);
  }

  @Get(':address/participants')
  async participants(@Param('address') address: string) {
    const rows = await this.service.getParticipants(address);
    return rows.map(serializeRow);
  }

  @Get(':address/matches')
  async matches(@Param('address') address: string) {
    const rows = await this.service.getMatches(address);
    return rows.map(serializeRow);
  }
}
