import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(join(__dirname, '../src/idl/bracket_chain.json'), 'utf8'));

const programId = new PublicKey('AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1');

console.log('IDL event names:', idl.events?.map((e) => e.name));
console.log('IDL spec/version:', { metadata: idl.metadata, address: idl.address });

const coder = new BorshCoder(idl);
const parser = new EventParser(programId, coder);

const logs = [
  'Program ComputeBudget111111111111111111111111111111 invoke [1]',
  'Program ComputeBudget111111111111111111111111111111 success',
  'Program ComputeBudget111111111111111111111111111111 invoke [1]',
  'Program ComputeBudget111111111111111111111111111111 success',
  'Program AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1 invoke [1]',
  'Program log: Instruction: CreateTournament',
  'Program 11111111111111111111111111111111 invoke [2]',
  'Program 11111111111111111111111111111111 success',
  'Program 11111111111111111111111111111111 invoke [2]',
  'Program 11111111111111111111111111111111 success',
  'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
  'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 233 of 181618 compute units',
  'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
  'Program data: ZiDwLTRAYQC4ksl4Z5vFPrxEikP4wVkwDAwPjKu2OdTsFc/IrsKnP5cHt8l6y4jYKlAgoNvyBbEDlTILUeK/ETF+sFqUA/K9O0Qss5EhV/E6kz0BNCgtAytf/s0Botvxt3kGCN8ALqcACT0AAAAAAAQAAdQl9mkAAAAA',
  'Program AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1 consumed 23221 of 199700 compute units',
  'Program AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1 success',
];

const events = Array.from(parser.parseLogs(logs));
console.log('parseLogs result count:', events.length);
for (const evt of events) {
  console.log('  event.name =', JSON.stringify(evt.name));
  console.log('  event.data =', JSON.stringify(evt.data, (k, v) => (typeof v === 'bigint' ? v.toString() : v?.toBase58?.() ?? v), 2));
}
