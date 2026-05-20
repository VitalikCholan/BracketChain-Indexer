#!/usr/bin/env node
/**
 * Test the indexer's event decoder against a live devnet (or mainnet) tx.
 *
 * Phase 2.5 added `organizer_deposit` and renamed `usdc_mint` → `token_mint`
 * in TournamentCreated; Phase 2.6 added the `name` field. Hardcoded payloads
 * predating either upgrade buffer-overrun the BorshCoder. So instead of
 * baking a Program-data string into this script (which goes stale on every
 * program redeploy), we fetch the tx's logMessages directly from RPC each
 * run.
 *
 * Usage:
 *   node scripts/test-parser.mjs <txSignature>
 *
 * Env:
 *   RPC_URL  — Solana RPC endpoint. Defaults to devnet public RPC.
 */
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(
  readFileSync(join(__dirname, '../src/idl/bracket_chain.json'), 'utf8'),
);

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? 'AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1',
);

const signature = process.argv[2];

if (!signature) {
  console.error('Usage: node scripts/test-parser.mjs <txSignature>');
  console.error('');
  console.error('IDL event names:', idl.events?.map((e) => e.name).join(', '));
  console.error('IDL spec/version:', {
    metadata: idl.metadata,
    address: idl.address,
  });
  console.error('Program ID:', PROGRAM_ID.toBase58());
  console.error('');
  console.error(
    'Tip: grab a recent TournamentCreated/MatchReported tx from Solana Explorer',
  );
  console.error(
    '     (https://explorer.solana.com/?cluster=devnet) and pass its signature here.',
  );
  process.exit(2);
}

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
console.log(`Fetching tx ${signature} from ${maskUrl(rpcUrl)}…`);
const connection = new Connection(rpcUrl, 'confirmed');

const tx = await connection.getTransaction(signature, {
  maxSupportedTransactionVersion: 0,
  commitment: 'confirmed',
});

if (!tx) {
  console.error(`Transaction not found: ${signature}`);
  process.exit(1);
}

if (tx.meta?.err) {
  console.warn('⚠️  Transaction reverted on-chain:', tx.meta.err);
}

const logs = tx.meta?.logMessages ?? [];
console.log(`Got ${logs.length} log messages.`);

const coder = new BorshCoder(idl);
const parser = new EventParser(PROGRAM_ID, coder);

const events = Array.from(parser.parseLogs(logs));
console.log(`Decoded ${events.length} event(s):`);

for (const evt of events) {
  console.log('  event.name =', JSON.stringify(evt.name));
  console.log(
    '  event.data =',
    JSON.stringify(
      evt.data,
      (_k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v && typeof v.toBase58 === 'function') return v.toBase58();
        // BN
        if (v && typeof v.toNumber === 'function' && typeof v.toString === 'function' && !Array.isArray(v)) {
          return v.toString();
        }
        return v;
      },
      2,
    ),
  );
}

function maskUrl(url) {
  return url.replace(/(\?|&)api-key=[^&]+/i, '$1api-key=***');
}
