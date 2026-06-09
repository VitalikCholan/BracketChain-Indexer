import { NonceStore } from './nonce.store';

describe('NonceStore', () => {
  let store: NonceStore;

  beforeEach(() => {
    store = new NonceStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('consume returns the stored entry exactly once (single-use)', () => {
    store.put('n1', { wallet: 'W', returnTo: 'https://app/x' });
    const first = store.consume('n1');
    expect(first).toMatchObject({ wallet: 'W', returnTo: 'https://app/x' });
    // Replay: the entry is gone after the first read.
    expect(store.consume('n1')).toBeNull();
  });

  it('consume returns null for an unknown nonce', () => {
    expect(store.consume('never-stored')).toBeNull();
  });

  it('treats entries older than the TTL as absent', () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    store.put('stale', { wallet: 'W', returnTo: '/' });

    // Jump 6 minutes past the 5-minute TTL.
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60 * 1000);
    expect(store.consume('stale')).toBeNull();
  });

  it('sweep evicts expired entries', () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    store.put('a', { wallet: 'W', returnTo: '/' });
    store.put('b', { wallet: 'W', returnTo: '/' });
    expect(store.size).toBe(2);

    jest.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60 * 1000);
    store.sweep();
    expect(store.size).toBe(0);
  });
});
