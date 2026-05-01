-- CreateEnum
CREATE TYPE "PayoutPreset" AS ENUM ('WinnerTakesAll', 'Standard', 'Deep');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('Registration', 'PendingBracketInit', 'Active', 'Completed', 'Cancelled');

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('Prize', 'Refund', 'Fee');

-- CreateTable
CREATE TABLE "Tournament" (
    "address" TEXT NOT NULL,
    "organizer" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "usdcMint" TEXT NOT NULL,
    "entryFee" BIGINT NOT NULL,
    "maxParticipants" INTEGER NOT NULL,
    "payoutPreset" "PayoutPreset" NOT NULL,
    "registrationDeadline" TIMESTAMP(3) NOT NULL,
    "status" "TournamentStatus" NOT NULL,
    "champion" TEXT,
    "grossPool" BIGINT,
    "feeAmount" BIGINT,
    "netPool" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdTxSig" TEXT NOT NULL,
    "completedTxSig" TEXT,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "tournamentAddress" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "kind" "PayoutKind" NOT NULL,
    "placement" INTEGER,
    "txSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tournament_status_idx" ON "Tournament"("status");

-- CreateIndex
CREATE INDEX "Tournament_organizer_idx" ON "Tournament"("organizer");

-- CreateIndex
CREATE INDEX "Payout_tournamentAddress_idx" ON "Payout"("tournamentAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_txSignature_recipient_kind_key" ON "Payout"("txSignature", "recipient", "kind");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tournamentAddress_fkey" FOREIGN KEY ("tournamentAddress") REFERENCES "Tournament"("address") ON DELETE CASCADE ON UPDATE CASCADE;
