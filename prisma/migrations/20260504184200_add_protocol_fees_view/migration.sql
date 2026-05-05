-- Phase 5.2: protocol_fees view.
-- Spec §6.2 lists `protocol_fees` as a separate table; in MVP we model it
-- as a Postgres VIEW over the Payout table where kind = 'Fee'. This avoids
-- duplicating data and keeps the indexer's webhook path simple — fee rows
-- are inserted once into Payout by the existing handleTournamentCompleted
-- handler, the view exposes them under their canonical name for SQL
-- consumers and dashboards.
--
-- Prisma doesn't manage views natively. This migration creates the view;
-- if the view ever needs columns added, write a follow-up migration with
-- DROP VIEW + CREATE VIEW (CREATE OR REPLACE works for additive changes
-- but not when removing columns).

CREATE OR REPLACE VIEW "protocol_fees" AS
SELECT
    "id",
    "tournamentAddress",
    "recipient" AS "treasury",
    "amount",
    "txSignature",
    "createdAt"
FROM "Payout"
WHERE "kind" = 'Fee';
