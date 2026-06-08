import { TournamentStatus } from '../generated/prisma';
import { VrfRevealDriver } from './vrf-reveal.driver';

// Stub the SDK + web3.js so the candidate-filtering and reveal-bundling logic
// runs offline. `revealSeed` is observable; PublicKey is an identity wrapper
// (test addresses aren't real 32-byte keys, so the real ctor would reject them).
jest.mock('@bracketchain/sdk', () => ({
  BracketChainClient: jest
    .fn()
    .mockImplementation(() => ({ signer: { address: 'VrfPayer1111' } })),
  revealSeed: jest.fn(),
}));
jest.mock('@solana/web3.js', () => ({
  PublicKey: jest.fn().mockImplementation((v: string) => ({ value: v })),
}));
// The driver statically imports SwitchboardVrfService (DI paramtype metadata),
// which pulls in @switchboard-xyz/on-demand — a heavy module that runs web3.js
// constructors at import time and breaks under the PublicKey stub. We inject a
// mock instance anyway, so replace the module with an empty class.
jest.mock('../switchboard/switchboard-vrf.service', () => ({
  SwitchboardVrfService: class {},
}));

const sdk = require('@bracketchain/sdk') as {
  BracketChainClient: jest.Mock;
  revealSeed: jest.Mock;
};

const DEFAULT_PUBKEY = '11111111111111111111111111111111'; // unbound sentinel
const RANDOMNESS = 'Rand1111111111111111111111111111111111111111';
const COMMIT_SLOT = 100;

/** Shapes a decoded-tournament stub the way ChainReaderService returns it. */
function decoded(opts: {
  randomness?: string;
  seedRevealed?: boolean;
  commitSlot?: number;
}) {
  return {
    vrfRandomnessAccount: { toBase58: () => opts.randomness ?? RANDOMNESS },
    seedRevealed: opts.seedRevealed ?? false,
    vrfCommitSlot: { toString: () => String(opts.commitSlot ?? COMMIT_SLOT) },
  };
}

function makeDeps(opts: {
  candidates?: { address: string }[];
  decodedList?: unknown[];
  currentSlot?: number;
}) {
  const prisma = {
    tournament: {
      findMany: jest.fn().mockResolvedValue(opts.candidates ?? []),
    },
  };
  const chain = {
    fetchTournaments: jest.fn().mockResolvedValue(opts.decodedList ?? []),
    getSlot: jest.fn().mockResolvedValue(opts.currentSlot ?? COMMIT_SLOT + 100),
  };
  const switchboard = {
    buildRevealKitInstruction: jest.fn().mockResolvedValue({ ix: 'reveal' }),
  };
  const cost = { recordRandomnessRequest: jest.fn() };
  const keychain = {
    getSigner: jest.fn().mockResolvedValue({ address: 'signer' }),
  };
  return { prisma, chain, switchboard, cost, keychain };
}

function makeDriver(deps: ReturnType<typeof makeDeps>): VrfRevealDriver {
  process.env.PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';
  return new VrfRevealDriver(
    deps.keychain as never,
    deps.prisma as never,
    deps.chain as never,
    deps.switchboard as never,
    deps.cost as never,
  );
}

type DriverPrivate = { tick: () => Promise<void>; drive: () => Promise<void> };
const asPrivate = (d: VrfRevealDriver) => d as unknown as DriverPrivate;

const CAND = { address: 'Tour1111111111111111111111111111111111111111' };

describe('VrfRevealDriver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.revealSeed.mockResolvedValue({ txSignature: 'tx' });
  });

  describe('candidate scan', () => {
    it('reads only pre-start tournaments (Registration / PendingBracketInit)', async () => {
      const deps = makeDeps({ candidates: [] });
      await asPrivate(makeDriver(deps)).tick();

      const arg = deps.prisma.tournament.findMany.mock.calls[0][0];
      expect(arg.where.status.in).toEqual([
        TournamentStatus.Registration,
        TournamentStatus.PendingBracketInit,
      ]);
      expect(arg.take).toBe(25);
    });

    it('no candidates → no chain read, no reveal', async () => {
      const deps = makeDeps({ candidates: [] });
      await asPrivate(makeDriver(deps)).tick();
      expect(deps.chain.fetchTournaments).not.toHaveBeenCalled();
      expect(sdk.revealSeed).not.toHaveBeenCalled();
    });
  });

  describe('eligibility filter', () => {
    it('skips a tournament with no VRF bound (default pubkey)', async () => {
      const deps = makeDeps({
        candidates: [CAND],
        decodedList: [decoded({ randomness: DEFAULT_PUBKEY })],
      });
      await asPrivate(makeDriver(deps)).tick();
      expect(sdk.revealSeed).not.toHaveBeenCalled();
    });

    it('skips an already-revealed seed', async () => {
      const deps = makeDeps({
        candidates: [CAND],
        decodedList: [decoded({ seedRevealed: true })],
      });
      await asPrivate(makeDriver(deps)).tick();
      expect(sdk.revealSeed).not.toHaveBeenCalled();
    });

    it('skips when the commit is too fresh (oracle not resolved yet)', async () => {
      const deps = makeDeps({
        candidates: [CAND],
        decodedList: [decoded({ commitSlot: COMMIT_SLOT })],
        currentSlot: COMMIT_SLOT + 1, // == commitSlot + MIN_SLOTS_AFTER_COMMIT → not >
      });
      await asPrivate(makeDriver(deps)).tick();
      expect(sdk.revealSeed).not.toHaveBeenCalled();
    });

    it('skips a candidate the chain read could not decode', async () => {
      const deps = makeDeps({ candidates: [CAND], decodedList: [undefined] });
      await asPrivate(makeDriver(deps)).tick();
      expect(sdk.revealSeed).not.toHaveBeenCalled();
    });
  });

  describe('reveal', () => {
    it('bound + matured + unrevealed → bundles reveal ix and submits, records cost', async () => {
      const deps = makeDeps({
        candidates: [CAND],
        decodedList: [decoded({ commitSlot: COMMIT_SLOT })],
        currentSlot: COMMIT_SLOT + 100,
      });
      await asPrivate(makeDriver(deps)).tick();

      // Switchboard reveal ix built with (randomnessAccount, payer-from-signer).
      expect(deps.switchboard.buildRevealKitInstruction).toHaveBeenCalledWith(
        RANDOMNESS,
        'VrfPayer1111',
      );
      expect(sdk.revealSeed).toHaveBeenCalledTimes(1);
      const arg = sdk.revealSeed.mock.calls[0][1];
      expect(arg.tournamentPda).toBe(CAND.address);
      expect(arg.randomnessAccount).toBe(RANDOMNESS);
      expect(arg.preInstructions).toEqual([{ ix: 'reveal' }]);
      expect(deps.cost.recordRandomnessRequest).toHaveBeenCalledTimes(1);
    });

    it('per-tournament error isolation → a not-yet-ready reveal does not abort the rest', async () => {
      const CAND2 = { address: 'Tour2222222222222222222222222222222222222222' };
      const deps = makeDeps({
        candidates: [CAND, CAND2],
        decodedList: [
          decoded({ randomness: RANDOMNESS }),
          decoded({
            randomness: 'Rand2222222222222222222222222222222222222222',
          }),
        ],
        currentSlot: COMMIT_SLOT + 100,
      });
      // First tournament's oracle hasn't posted yet → revealIx build throws.
      deps.switchboard.buildRevealKitInstruction
        .mockRejectedValueOnce(new Error('randomness not yet revealed'))
        .mockResolvedValueOnce({ ix: 'reveal2' });

      await asPrivate(makeDriver(deps)).tick(); // must not throw

      expect(sdk.revealSeed).toHaveBeenCalledTimes(1);
      expect(sdk.revealSeed.mock.calls[0][1].tournamentPda).toBe(CAND2.address);
      expect(deps.cost.recordRandomnessRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('production guard (via drive)', () => {
    afterEach(() => {
      delete process.env.PERMISSIONLESS_DRIVERS_ENABLED;
      delete process.env.PERMISSIONLESS_VRF_REVEAL_ENABLED;
    });

    it('default-off → tick never runs', async () => {
      const deps = makeDeps({ candidates: [CAND] });
      await asPrivate(makeDriver(deps)).drive();
      expect(deps.prisma.tournament.findMany).not.toHaveBeenCalled();
    });

    it('both flags on → tick runs', async () => {
      process.env.PERMISSIONLESS_DRIVERS_ENABLED = 'true';
      process.env.PERMISSIONLESS_VRF_REVEAL_ENABLED = 'true';
      const deps = makeDeps({ candidates: [] });
      await asPrivate(makeDriver(deps)).drive();
      expect(deps.prisma.tournament.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
