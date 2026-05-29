import { SteamOpenIdService } from './steam-openid.service';

describe('SteamOpenIdService', () => {
  let svc: SteamOpenIdService;

  beforeEach(() => {
    svc = new SteamOpenIdService();
    process.env.STEAM_REALM = 'https://indexer.test';
    process.env.STEAM_RETURN_URL = 'https://indexer.test/identity/steam/callback';
  });

  afterEach(() => jest.restoreAllMocks());

  describe('buildLoginUrl', () => {
    it('points return_to at the callback carrying the nonce', () => {
      const url = new URL(svc.buildLoginUrl('nonce-xyz'));
      expect(url.origin + url.pathname).toBe(
        'https://steamcommunity.com/openid/login',
      );
      expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
      expect(url.searchParams.get('openid.realm')).toBe('https://indexer.test');
      const returnTo = new URL(url.searchParams.get('openid.return_to')!);
      expect(returnTo.pathname).toBe('/identity/steam/callback');
      expect(returnTo.searchParams.get('n')).toBe('nonce-xyz');
    });
  });

  describe('verifyCallback', () => {
    const goodParams = {
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.claimed_id':
        'https://steamcommunity.com/openid/id/76561198000000000',
    };

    function mockSteam(body: string) {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(body) as unknown as Response);
    }

    it('returns the steamId64 when Steam confirms is_valid:true', async () => {
      mockSteam('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
      await expect(svc.verifyCallback(goodParams)).resolves.toBe(
        '76561198000000000',
      );
    });

    it('returns null when Steam answers is_valid:false', async () => {
      mockSteam('ns:...\nis_valid:false\n');
      await expect(svc.verifyCallback(goodParams)).resolves.toBeNull();
    });

    it('returns null when the network request fails', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
      await expect(svc.verifyCallback(goodParams)).resolves.toBeNull();
    });

    it('returns null for a valid assertion with a malformed claimed_id', async () => {
      mockSteam('is_valid:true');
      await expect(
        svc.verifyCallback({ ...goodParams, 'openid.claimed_id': 'garbage' }),
      ).resolves.toBeNull();
    });
  });
});
