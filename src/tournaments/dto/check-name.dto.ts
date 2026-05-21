import { IsString, Length } from 'class-validator';

/**
 * Query for `GET /tournaments/check-name?organizer=<wallet>&name=<name>`.
 *
 * Uniqueness scope is per-organizer because the on-chain `Tournament` PDA is
 * derived from `[b"tournament", organizer, name.as_bytes()]`. Two different
 * organizers can use the same name without collision.
 *
 * `name` upper bound matches the program's `MAX_TOURNAMENT_NAME_LEN` (32).
 * `organizer` is loosely range-checked rather than full base58 validation —
 * the DB lookup is safe with any string; malformed pubkeys just return
 * `{ taken: false }` and the wallet flow fails downstream.
 */
export class CheckNameQueryDto {
  @IsString()
  @Length(32, 44)
  organizer!: string;

  @IsString()
  @Length(1, 32)
  name!: string;
}
