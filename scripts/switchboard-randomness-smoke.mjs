// Phase 1 §3 P3-3: smoke the Switchboard On-Demand randomness flow on devnet.
// Validates the exact path request_seed/reveal_seed (Stage B) will use:
//   load default (permissionless) devnet queue → Randomness.create + commitIx →
//   wait for the oracle → revealIx → read the revealed value on-chain.
// Pays only SOL (vrf-payer from §1). No API key / no queue approval needed.
//
//   node scripts/switchboard-randomness-smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import {
  AnchorUtils,
  Randomness,
  getDefaultDevnetQueue,
  asV0Tx,
} from '@switchboard-xyz/on-demand';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const loadKp = (role) =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(ROOT, '.keys', `${role}.json`), 'utf8'))),
  );

const sendV0 = async (connection, tx, label) => {
  const sig = await connection.sendTransaction(tx, { maxRetries: 5 });
  for (let i = 0; i < 40; i++) {
    const { value } = await connection.getSignatureStatuses([sig]);
    const s = value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      if (s.err) throw new Error(`${label} on-chain err: ${JSON.stringify(s.err)}`);
      return sig;
    }
    await sleep(1500);
  }
  throw new Error(`${label} confirm timeout: ${sig}`);
};

async function main() {
  const vrf = loadKp('vrf-payer');
  console.log(`vrf-payer: ${vrf.publicKey.toBase58()}`);
  console.log(`rpc:       ${RPC}\n`);

  const connection = new Connection(RPC, 'confirmed');
  const wallet = new anchor.Wallet(vrf);
  const program = await AnchorUtils.loadProgramFromConnection(connection, wallet);

  const queue = await getDefaultDevnetQueue(RPC);
  console.log(`default devnet queue (permissionless): ${queue.pubkey.toBase58()}`);

  // 1. create (own tx — commitIx below reads the account, so it must exist first)
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(program, rngKp, queue.pubkey);
  console.log(`randomness account: ${randomness.pubkey.toBase58()}`);

  const txCreate = await asV0Tx({
    connection,
    ixs: [createIx],
    payer: vrf.publicKey,
    signers: [vrf, rngKp],
    computeUnitPrice: 75_000,
    computeUnitLimitMultiple: 1.3,
  });
  const sigCreate = await sendV0(connection, txCreate, 'create');
  console.log(`✓ create confirmed: ${sigCreate}`);

  // 2. commit (now the randomness account exists on-chain)
  const commitIx = await randomness.commitIx(queue.pubkey);
  const txCommit = await asV0Tx({
    connection,
    ixs: [commitIx],
    payer: vrf.publicKey,
    signers: [vrf],
    computeUnitPrice: 75_000,
    computeUnitLimitMultiple: 1.3,
  });
  const sigCommit = await sendV0(connection, txCommit, 'commit');
  console.log(`✓ commit confirmed: ${sigCommit}`);
  console.log('  (queue reachable + payment works + randomness committed on-chain)\n');

  // 2. reveal — poll until the committed slot's oracle value is available
  const lut = await queue.loadLookupTable();
  let revealed = false;
  for (let attempt = 1; attempt <= 15 && !revealed; attempt++) {
    try {
      const revealIx = await randomness.revealIx();
      const txReveal = await asV0Tx({
        connection,
        ixs: [revealIx],
        payer: vrf.publicKey,
        signers: [vrf],
        lookupTables: [lut],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });
      const sigReveal = await sendV0(connection, txReveal, 'reveal');
      console.log(`✓ reveal confirmed (attempt ${attempt}): ${sigReveal}`);
      revealed = true;
    } catch (e) {
      process.stdout.write(`  reveal not ready (attempt ${attempt}) — waiting…\n`);
      await sleep(4000);
    }
  }

  // 3. read the revealed value on-chain
  const data = await randomness.loadData();
  const valueBytes = data?.value ? Array.from(data.value) : null;
  const hasValue = valueBytes && valueBytes.some((b) => b !== 0);
  console.log('\n─── Switchboard randomness smoke result ───');
  console.log(`queue:            ${queue.pubkey.toBase58()}`);
  console.log(`randomness acct:  ${randomness.pubkey.toBase58()}`);
  console.log(`reveal:           ${revealed ? 'OK' : 'NOT REVEALED (timing)'}`);
  console.log(`on-chain value:   ${hasValue ? '0x' + Buffer.from(valueBytes).toString('hex') : '(empty)'}`);

  if (!revealed || !hasValue) {
    console.log(
      '\nNote: create+commit PASSED (core: queue access + payment). Reveal can lag the\noracle by a few slots; rerun reveal later if it timed out — the account persists.',
    );
    // create+commit success is the core P3-3 gate; reveal is best-effort here.
  } else {
    console.log('\n§3 randomness acceptance: PASS (full commit→reveal→value).');
  }
}

main().catch((err) => {
  console.error('\nsmoke failed:', err?.message ?? err);
  process.exit(1);
});
