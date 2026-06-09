import { Injectable, Logger } from '@nestjs/common';

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
// Steam returns the identity as https://steamcommunity.com/openid/id/<steamId64>.
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Steam OpenID 2.0 server-side flow (A11-3), owned entirely by the indexer
 * under Option B (the frontend no longer touches Steam).
 *
 * Steam still speaks OpenID 2.0 (not OAuth/OIDC), so this is hand-rolled with
 * `fetch` — no library needed. The only security-critical step is
 * `verifyCallback`: it re-asks Steam to authenticate the assertion
 * (`check_authentication`) instead of trusting the `openid.*` params the
 * browser delivered.
 *
 * Config:
 *  - `STEAM_REALM`       the realm presented to the user (e.g. the indexer origin)
 *  - `STEAM_RETURN_URL`  the indexer's own /identity/steam/callback URL
 */
@Injectable()
export class SteamOpenIdService {
  private readonly logger = new Logger(SteamOpenIdService.name);

  private get realm(): string {
    const realm = process.env.STEAM_REALM;
    if (!realm) throw new Error('STEAM_REALM env var is required');
    return realm;
  }

  private get returnUrl(): string {
    const url = process.env.STEAM_RETURN_URL;
    if (!url) throw new Error('STEAM_RETURN_URL env var is required');
    return url;
  }

  /**
   * Build the `checkid_setup` redirect URL. `identifier_select` lets Steam pick
   * the logged-in user. `nonce` is carried on the return URL so the callback
   * can recover the pending `{ wallet, returnTo }` entry.
   */
  buildLoginUrl(nonce: string): string {
    const returnTo = new URL(this.returnUrl);
    returnTo.searchParams.set('n', nonce);

    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo.toString(),
      'openid.realm': this.realm,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    return `${STEAM_OPENID}?${params.toString()}`;
  }

  /**
   * Verify the OpenID assertion server-side and extract the Steam ID 64.
   *
   * Echoes every `openid.*` param back to Steam with `mode=check_authentication`;
   * Steam answers `is_valid:true` only for a genuine, unmodified assertion it
   * issued. Returns the 17-digit Steam ID 64, or `null` for any failure
   * (network error, `is_valid:false`, missing/malformed `claimed_id`).
   */
  async verifyCallback(
    params: Record<string, string | undefined>,
  ): Promise<string | null> {
    const verifyParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('openid.') && v !== undefined) verifyParams.set(k, v);
    }
    verifyParams.set('openid.mode', 'check_authentication');

    let verifyText: string;
    try {
      const res = await fetch(STEAM_OPENID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verifyParams.toString(),
      });
      verifyText = await res.text();
    } catch (err) {
      this.logger.warn(
        `Steam check_authentication request failed: ${String(err)}`,
      );
      return null;
    }

    if (!/is_valid\s*:\s*true/i.test(verifyText)) {
      this.logger.warn('Steam assertion not valid (is_valid:false)');
      return null;
    }

    const claimedId = params['openid.claimed_id'] ?? '';
    const match = CLAIMED_ID_RE.exec(claimedId);
    if (!match) {
      this.logger.warn(
        `verified assertion but malformed claimed_id: ${claimedId}`,
      );
      return null;
    }
    return match[1];
  }
}
