#!/usr/bin/env node
// Copy the canonical Anchor IDL from the sibling programs repo into our src.
// Run after `anchor build` in bracket-chain-programs whenever the IDL changes.
//
// Usage: pnpm sync-idl   (alias added in package.json)

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SOURCE = resolve(
  ROOT,
  '..',
  'bracket-chain-programs',
  'target',
  'idl',
  'bracket_chain.json',
);
const DEST_DIR = resolve(ROOT, 'src', 'idl');
const DEST = resolve(DEST_DIR, 'bracket_chain.json');

if (!existsSync(SOURCE)) {
  console.error(`[sync-idl] Source IDL not found at: ${SOURCE}`);
  console.error('[sync-idl] Run `anchor build` in bracket-chain-programs first.');
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SOURCE, DEST);
console.log(`[sync-idl] Copied IDL → ${DEST}`);
