-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('None', 'Player', 'Oracle', 'GameServer');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MatchStatus" ADD VALUE 'PendingConfirmation';
ALTER TYPE "MatchStatus" ADD VALUE 'Disputed';

-- DropIndex
DROP INDEX "Match_tournamentAddress_round_matchIndex_key";

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "bracket" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimDeadline" TIMESTAMP(3),
ADD COLUMN     "disputeReason" INTEGER,
ADD COLUMN     "disputed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposalSource" "ProposalSource" NOT NULL DEFAULT 'None',
ADD COLUMN     "proposedAt" TIMESTAMP(3),
ADD COLUMN     "proposedWinner" TEXT,
ADD COLUMN     "proposer" TEXT;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "identityHash" TEXT,
ADD COLUMN     "losses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsAgainst" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsFor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wins" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Match_tournamentAddress_bracket_round_matchIndex_key" ON "Match"("tournamentAddress", "bracket", "round", "matchIndex");

