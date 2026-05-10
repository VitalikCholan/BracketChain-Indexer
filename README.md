# BracketChain — Indexer

NestJS read API + Helius webhook ingestor for the [BracketChain](https://github.com/VitalikCholan/BracketChain-Main) on-chain tournament protocol on Solana. Backs the `/explore` listing and stale-while-revalidate reads on `/t/[id]` in the frontend; consumed via [`@bracketchain/sdk`'s `BracketChainIndexerClient`](../bracket-chain-sdk).

This repo contains only the indexer service. The full system spans five repos — see [Related repositories](#related-repositories) below.

---

## Status

| Field | Value |
|---|---|
| Production URL | [`https://bracketchain-indexer-production.up.railway.app`](https://bracketchain-indexer-production.up.railway.app) |
| Health endpoint | [`/health`](https://bracketchain-indexer-production.up.railway.app/health) |
| Stack | NestJS 11, Prisma 7 + `@prisma/adapter-pg`, Postgres on Neon |
| Ingest | Helius enhanced webhooks (POST `/webhooks/helius`) |
| Reconciliation | `@nestjs/schedule` cron, `EVERY_MINUTE` |
| Devnet program | `AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1` |
| License | MIT |

---

## What it does

Ingests Anchor events from the on-chain BracketChain program via Helius webhooks, persists them to a 4-table Postgres schema, and exposes a typed REST surface for the frontend's listing + read paths. A minute-cadence reconciliation cron corrects drift when webhooks drop.

Three logical sub-systems:

- **Webhook ingest** — `POST /webhooks/helius` accepts Helius enhanced-webhook payloads, decodes Anchor events via a `BorshCoder` over the vendored IDL, and writes one or more rows per event. Idempotent via Prisma unique constraints (Helius redelivers).
- **Read API** — five `GET` endpoints under `/tournaments` mirror what the frontend needs for `/explore` and `/t/[id]`. BigInt fields serialize as decimal strings (Phase 5.1).
- **Reconciliation cron** — every minute, scans non-terminal + recently-completed (last 1h) tournaments, batches `getMultipleAccountsInfo` (≤50 PDAs/pass), patches `status` / `champion` / slot drift, and bumps `chainSlotAtWrite` to mark "freshly verified." Health endpoint exposes its last-tick metadata.

---

## REST API

All endpoints accept an `AbortSignal`-friendly client (the SDK uses fetch).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tournaments?status=&limit=` | Paginated listing (used by `/explore`). `status` filters to a single `TournamentStatus`. Default `limit=20`, max `100`. |
| `GET` | `/tournaments/:address` | Single tournament by PDA — backs `/t/[id]` indexer reads. 404 on miss. |
| `GET` | `/tournaments/:address/payouts` | All `Payout` rows — `kind ∈ { Prize, Refund, Fee, OrganizerRefund }`. |
| `GET` | `/tournaments/:address/participants` | Per-participant cache (Phase 5.2). |
| `GET` | `/tournaments/:address/matches` | Reported matches only. Pending matches are NOT seeded — fall back to chain (`getAllMatches` from the SDK) for full bracket topology. |
| `GET` | `/health` | Liveness + reconciliation snapshot — `lastReconcileAt`, scanned/touched counts, `lastReconcileError`. |
| `POST` | `/webhooks/helius` | Helius webhook ingest. **Currently unauthenticated** — see [Webhook security](#webhook-security) below. |

DTOs use `class-validator` (status enum, limit 1–100). BigInt → decimal string serialization is handled by `serializeBigInts<T>()` in the controllers.

### Example

```bash
curl -s "$INDEXER/tournaments?status=Registration&limit=5" | jq .
curl -s "$INDEXER/tournaments/AuXJ.../payouts" | jq '.[] | {kind, amount, recipient}'
curl -s "$INDEXER/health" | jq '.reconciliation'
# { "lastReconcileAt": "...", "lastReconcileScanned": 23, "lastReconcileTouched": 2, "lastReconcileError": null }
```

Consumers should prefer the typed wrapper:

```ts
import { BracketChainIndexerClient } from "@bracketchain/sdk";

const indexer = new BracketChainIndexerClient({ baseUrl: process.env.NEXT_PUBLIC_INDEXER_URL! });
await indexer.listTournaments({ status: "Registration", limit: 20 });
```

---

## Webhook contract

`POST /webhooks/helius` receives [Helius enhanced webhooks](https://docs.helius.dev/webhooks-and-websockets/webhooks) configured to fire on the BracketChain program. The handler:

1. Reads `tx.meta.logMessages` from each transaction in the payload
2. Decodes Anchor events via `EventParser` + `BorshCoder` over the vendored IDL at [`src/idl/bracket_chain.json`](./src/idl/bracket_chain.json)
3. Dispatches by event name to the per-event handler
4. Writes inside a Prisma `$transaction` for multi-row events (e.g. `TournamentCompleted` → 1 Tournament row update + N Payout rows + 1 Fee Payout row)

### Event coverage

| Anchor event | Handler effect |
|---|---|
| `TournamentCreated` | Insert `Tournament` row (status `Registration`, `chainSlotAtWrite` from tx slot) |
| `ParticipantRegistered` | Insert `Participant` row + bump `Tournament.chainSlotAtWrite` |
| `TournamentStarted` | Flip `Tournament.status` to `PendingBracketInit` / `Active` |
| `MatchReported` | Upsert `Match` row (Completed) |
| `TournamentCompleted` | Upsert `Tournament` (status, champion, gross/fee/net pool); insert N+1 `Payout` rows from event-embedded `placement_payouts` + `treasury_recipient` (Phase 5.2 path D — fixes the earlier P6-4 webhook gap by avoiding a transaction-log scan); falls back to `tx.tokenTransfers` parsing for pre-event-upgrade replays |
| `TournamentCancelled` | Flip `Tournament.status` to `Cancelled` |
| `RefundIssued` | Insert `Payout` row with `kind = Refund` (entry-fee) or `OrganizerRefund` (Phase 2.5 organizer-deposit refund); flip `Participant.refundPaid` for entry-fee refunds |

### Idempotency

`Payout @@unique([txSignature, recipient, kind])` guarantees Helius redeliveries can't double-insert. Tournament + Participant + Match upserts are PDA-keyed, so re-applying the same event is a no-op.

### Webhook security

`POST /webhooks/helius` is currently **unauthenticated** — any caller can submit a payload. `.env.example` reserves `HELIUS_WEBHOOK_SECRET` (currently commented out) for an HMAC guard, but the code path that validates it is not wired. Acceptable for devnet MVP; **mainnet-prep gate**, alongside the program's Squads multisig migration. Tracked in the main repo's risk register.

---

## Reconciliation cron

`ReconciliationService.reconcile()` runs every minute via `@Cron(CronExpression.EVERY_MINUTE)`. Each tick:

1. Queries up to 50 non-terminal + recently-completed (last 1h) tournaments
2. Batches them through `ChainReaderService.fetchTournaments(pdas)`, which wraps `connection.getMultipleAccountsInfo()` in 100-pubkey chunks
3. Compares each row's `status`, `champion`, and `chainSlotAtWrite` against the live account
4. Patches the DB if any field drifts; bumps `chainSlotAtWrite` to current slot regardless
5. Writes its tick metadata to in-memory state for the `/health` endpoint

This covers single webhook drops within ~60s. It does NOT seed missing Participant or Match rows from chain — that's V1 (`getProgramAccounts`-based participant/match reconciliation per the main repo's open-architecture items). Lean-indexer philosophy: webhooks are the source of truth for participant/match rows, the cron only patches Tournament-level drift.

---

## Schema

4 Prisma models + 4 enums in [`prisma/schema.prisma`](./prisma/schema.prisma):

```
Tournament
├── address (PK, Solana PDA)
├── organizer, name, tokenMint
├── entryFee, organizerDeposit (BigInt)
├── maxParticipants, payoutPreset (enum), registrationDeadline
├── status (enum), champion?
├── grossPool?, feeAmount?, netPool? (BigInt; populated on TournamentCompleted)
├── createdTxSig, completedTxSig?
└── chainSlotAtWrite (BigInt — Phase 5.1 freshness watermark)

Participant — @@unique(tournamentAddress, wallet)
├── wallet, seedIndex, refundPaid
├── registeredTxSig
└── chainSlotAtWrite

Match — @@unique(tournamentAddress, round, matchIndex)
├── playerA?, playerB?, winner?
├── status (enum: Pending | Active | Completed), bye
├── reportedTxSig?
└── chainSlotAtWrite

Payout — @@unique(txSignature, recipient, kind)
├── recipient, amount (BigInt), kind (enum: Prize | Refund | Fee | OrganizerRefund)
├── placement?
└── txSignature
```

Plus one Postgres `VIEW` declared via raw SQL in migration `20260504184200_add_protocol_fees_view`:

```sql
CREATE VIEW protocol_fees AS SELECT ... FROM "Payout" WHERE kind = 'Fee'
```

The view isn't representable in `schema.prisma` (Prisma can't declare views in a fluent way). It's read by SQL or via `prisma.$queryRaw` if you need it.

### Notable schema decisions

- **`tokenMint`, not `usdcMint`.** Renamed 2026-05-03 in Phase 2.5. The on-chain program is mint-agnostic; `protocol_config.default_mint` is advisory only. USDC is one of many possible mints.
- **`organizerDeposit BigInt @default(0)`.** Phase 2.5 added optional organizer top-up to the prize pool. Zero when not provided (Variant B optional).
- **`chainSlotAtWrite` on three tables.** Phase 5.1 freshness watermark — frontend's SWR layer treats a row as potentially stale when `currentSlot - chainSlotAtWrite > 150` slots (~60s) and enqueues a chain reconcile.
- **`Match` has nullable `playerA`/`playerB`.** Match rows are ingested only when `MatchReported` fires (Completed). Pending and bye matches live on chain until the reconciliation cron upgrades to seeding them.

### Migrations

Five migrations applied to-date in `prisma/migrations/`:

| Migration | Phase |
|---|---|
| `20260501165847_init` | Phase 4 — initial schema |
| `20260503075937_add_organizer_deposit_and_token_mint_rename` | Phase 2.5 |
| `20260504183105_add_chain_slot_at_write` | Phase 5.1 |
| `20260504184116_add_participants_and_matches` | Phase 5.2 |
| `20260504184200_add_protocol_fees_view` | Phase 5.2 |

`pnpm prisma migrate dev` to apply locally; `start:prod` runs `prisma migrate deploy` before `node dist/main` (see [`Procfile`](./Procfile) for the Railway entrypoint).

---

## Environment variables

Required:

| Var | Read by | Notes |
|---|---|---|
| `DATABASE_URL` | `prisma.service.ts:9` | Neon pooled connection string |
| `RPC_URL` | `chain-reader.service.ts:25` | Solana RPC endpoint. **⚠️ `.env.example` documents this as `SOLANA_RPC_URL` — that name is read nowhere; use `RPC_URL`.** Without it, the reconciliation cron logs an error and skips every tick. |
| `PROGRAM_ID` | `chain-reader.service.ts:26`, `helius-parser.service.ts:45` | Program PDA — `AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1` for devnet |

Optional:

| Var | Read by | Default |
|---|---|---|
| `PORT` | `main.ts:21` | `3000` (Railway sets this) |
| `FRONTEND_ORIGIN` | `main.ts:9` | `*` — comma-separated allowlist; lock down before prod |
| `TOKEN_MINT_FILTER` / `USDC_MINT` | `helius-parser.service.ts:53` | unset — apply only if you want to skip non-USDC payouts. **Leave unset for the multi-token MVP.** |
| `HELIUS_WEBHOOK_SECRET` | (reserved — not yet wired) | Add HMAC guard before mainnet |

**Known issue with `.env.example`:** the example file documents `SOLANA_RPC_URL`, `SOLANA_CLUSTER`, and `HELIUS_API_KEY`. Of those, only `SOLANA_RPC_URL` would actually be read by the code if it were named correctly — and it isn't. Copying `.env.example` → `.env` verbatim breaks reconciliation. Set `RPC_URL` instead. (Tracked as a one-line fix.)

---

## Run locally

Requires Node 20+ and `pnpm`.

```bash
pnpm install
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, RPC_URL (NOT SOLANA_RPC_URL), PROGRAM_ID
pnpm prisma migrate dev      # apply 5 migrations + generate the Prisma client
pnpm start:dev               # NestJS in watch mode on PORT (default 3000)
```

Smoke test:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/tournaments
```

Production-style:

```bash
pnpm build                   # = prisma generate + nest build
pnpm start:prod              # = prisma migrate deploy + node dist/main
```

The `start:prod` script is what Railway runs via [`Procfile`](./Procfile) (`web: pnpm start:prod`). Don't run `prisma migrate dev` in production — it'll prompt for shadow-database setup and rename detection. Use `migrate deploy` (which `start:prod` already does).

### Ingest end-to-end locally

The webhook is open by design (Helius doesn't sign requests). To replay a real Helius payload:

```bash
curl -X POST http://localhost:3000/webhooks/helius \
  -H "Content-Type: application/json" \
  -d @scripts/test-fixtures/tournament_completed.json
```

Or test event parsing in isolation via the helper script:

```bash
pnpm tsx scripts/test-parser.mjs <txSignature>
```

---

## Tests

```bash
pnpm test                # unit
pnpm test:e2e            # e2e
pnpm test:cov            # with coverage
```

Coverage today is thin — `app.controller.spec.ts` is the auto-generated NestJS scaffold; `test/app.e2e-spec.ts` is minimal. Webhook parsing and reconciliation cron drift detection have no automated tests. Pre-mainnet hardening item.

---

## Repository layout

```
.
├── package.json             # NestJS 11, Prisma 7, @coral-xyz/anchor 0.32.1
├── nest-cli.json            # Nest build config
├── prisma.config.ts         # Prisma 7 driver-adapter setup (@prisma/adapter-pg)
├── prisma/
│   ├── schema.prisma        # 4 models, 4 enums
│   └── migrations/          # 5 migrations
├── src/
│   ├── main.ts              # bootstrap + ValidationPipe + CORS
│   ├── app.module.ts        # module wiring (Tournaments, Webhooks, Reconciliation, Health)
│   ├── prisma.service.ts    # Prisma client provider
│   ├── tournaments/         # REST endpoints + service + DTOs
│   ├── webhooks/            # POST /webhooks/helius + HeliusParserService (BorshCoder + EventParser)
│   ├── reconciliation/      # @Cron service + module
│   ├── chain/               # ChainReaderService — getMultipleAccountsInfo wrapper
│   ├── health/              # GET /health
│   ├── idl/                 # vendored IDL (bracket_chain.json + bracket_chain.ts)
│   └── generated/           # Prisma client output (gitignored)
├── scripts/
│   ├── sync-idl.mjs         # copy IDL from program target/idl/ (manual; same as program's make sync-idl)
│   └── test-parser.mjs      # parse a single tx by signature for debugging
├── test/                    # e2e scaffolding
├── .env.example
└── Procfile                 # Railway entrypoint: web: pnpm start:prod
```

---

## Related repositories

| Repo | Purpose |
|---|---|
| [`bracketchain-main`](../bracketchain-main) | Top-level README, hackathon plan, MVP-vs-V1 deltas, demo script |
| [`bracket-chain-programs`](../bracket-chain-programs) | The Anchor program — source of the vendored IDL ingested here |
| [`bracket-chain-sdk`](../bracket-chain-sdk) | TypeScript SDK — wraps this REST API as `BracketChainIndexerClient` |
| [`BracketChain-Frontend`](../BracketChain-Frontend) | Next.js web app — primary consumer (via SDK) |

---

## License

MIT. See [`LICENSE`](./LICENSE).
