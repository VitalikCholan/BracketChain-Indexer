import { Injectable, Logger } from '@nestjs/common';
import type { WinnerSource } from './winner-source';

const STEAM64_TO_ACCOUNT_OFFSET = 76561197960265728n;

const FETCH_TIMEOUT_MS = 10_000;

interface OpenDotaRecentMatch {
  match_id: number;
  player_slot: number;
  radiant_win: boolean | null;
  start_time: number; // unix seconds
}

@Injectable()
export class OpenDotaService implements WinnerSource {
  private readonly logger = new Logger(OpenDotaService.name);

  private get baseUrl(): string {
    return (
      process.env.OPENDOTA_BASE_URL ?? 'https://api.opendota.com'
    ).replace(/\/+$/, '');
  }

  async resolveWinner(
    steamIdA: string,
    steamIdB: string,
    committedAtUnix: number,
  ): Promise<0 | 1 | null> {
    const [matchesA, matchesB] = await Promise.all([
      this.recentMatches(steamIdA),
      this.recentMatches(steamIdB),
    ]);
    if (!matchesA || !matchesB) return null;

    const aById = new Map<number, OpenDotaRecentMatch>();
    for (const m of matchesA) {
      if (m.start_time > committedAtUnix) aById.set(m.match_id, m);
    }

    let shared: { a: OpenDotaRecentMatch; b: OpenDotaRecentMatch } | null =
      null;
    for (const mb of matchesB) {
      if (mb.start_time <= committedAtUnix) continue;
      const ma = aById.get(mb.match_id);
      if (!ma) continue;
      if (!shared || ma.start_time < shared.a.start_time)
        shared = { a: ma, b: mb };
    }
    if (!shared) return null;

    const aRadiant = shared.a.player_slot < 128;
    const bRadiant = shared.b.player_slot < 128;
    if (aRadiant === bRadiant) {
      // Same team — not the committed 1v1 duel; refuse to settle from it.
      this.logger.warn(
        `shared match ${shared.a.match_id} has both players on one team — ignoring`,
      );
      return null;
    }
    if (typeof shared.a.radiant_win !== 'boolean') return null;

    return aRadiant === shared.a.radiant_win ? 0 : 1;
  }

  /**
   * `GET /api/players/{account_id}/recentMatches` — returns `null` on any
   * non-OK / non-array response (rate limit, private history, bad id) so the
   * caller fails closed.
   */
  private async recentMatches(
    steamId64: string,
  ): Promise<OpenDotaRecentMatch[] | null> {
    let accountId: bigint;
    try {
      accountId = BigInt(steamId64) - STEAM64_TO_ACCOUNT_OFFSET;
    } catch {
      return null;
    }
    if (accountId <= 0n) return null;

    const url = `${this.baseUrl}/api/players/${accountId}/recentMatches`;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      this.logger.warn(
        `OpenDota fetch failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`OpenDota ${res.status} for account ${accountId}`);
      return null;
    }
    const json: unknown = await res.json().catch(() => null);
    if (!Array.isArray(json)) return null;

    return json.filter(
      (m): m is OpenDotaRecentMatch =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as OpenDotaRecentMatch).match_id === 'number' &&
        typeof (m as OpenDotaRecentMatch).player_slot === 'number' &&
        typeof (m as OpenDotaRecentMatch).start_time === 'number',
    );
  }
}
