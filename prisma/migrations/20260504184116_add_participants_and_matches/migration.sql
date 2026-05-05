-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('Pending', 'Active', 'Completed');

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "tournamentAddress" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "seedIndex" INTEGER NOT NULL,
    "refundPaid" BOOLEAN NOT NULL DEFAULT false,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredTxSig" TEXT NOT NULL,
    "chainSlotAtWrite" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "tournamentAddress" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "matchIndex" INTEGER NOT NULL,
    "playerA" TEXT,
    "playerB" TEXT,
    "winner" TEXT,
    "status" "MatchStatus" NOT NULL DEFAULT 'Pending',
    "bye" BOOLEAN NOT NULL DEFAULT false,
    "reportedAt" TIMESTAMP(3),
    "reportedTxSig" TEXT,
    "chainSlotAtWrite" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Participant_tournamentAddress_idx" ON "Participant"("tournamentAddress");

-- CreateIndex
CREATE INDEX "Participant_wallet_idx" ON "Participant"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_tournamentAddress_wallet_key" ON "Participant"("tournamentAddress", "wallet");

-- CreateIndex
CREATE INDEX "Match_tournamentAddress_idx" ON "Match"("tournamentAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Match_tournamentAddress_round_matchIndex_key" ON "Match"("tournamentAddress", "round", "matchIndex");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_tournamentAddress_fkey" FOREIGN KEY ("tournamentAddress") REFERENCES "Tournament"("address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_tournamentAddress_fkey" FOREIGN KEY ("tournamentAddress") REFERENCES "Tournament"("address") ON DELETE CASCADE ON UPDATE CASCADE;
