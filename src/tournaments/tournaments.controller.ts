import { Controller, Get, Param, Query } from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { ListTournamentsQueryDto } from './dto/list-tournaments.dto';

// JSON.stringify can't serialize BigInt — convert to string in API responses.
type Serialized<T> = {
  [K in keyof T]: T[K] extends bigint ? string : T[K] extends bigint | null ? string | null : T[K];
};

function serializeBigInts<T extends Record<string, unknown>>(row: T): Serialized<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out as Serialized<T>;
}

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly service: TournamentsService) {}

  @Get()
  async list(@Query() query: ListTournamentsQueryDto) {
    const rows = await this.service.list({ status: query.status, limit: query.limit });
    return rows.map(serializeBigInts);
  }

  @Get(':address/payouts')
  async payouts(@Param('address') address: string) {
    const rows = await this.service.getPayouts(address);
    return rows.map(serializeBigInts);
  }
}
