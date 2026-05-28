-- Stage C (V1.2 Oracle settlement): Tournament.arbitrator + MatchCommitment
-- snapshot + bound feed. All columns nullable so pre-V1.2 rows decode and
-- non-Oracle (OrganizerOnly / PlayerReported) matches stay clean.

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "arbitrator" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "committedAt" TIMESTAMP(3),
ADD COLUMN     "expectedFeedHash" BYTEA,
ADD COLUMN     "lobbyId" BYTEA,
ADD COLUMN     "playerAGameId" BYTEA,
ADD COLUMN     "playerBGameId" BYTEA,
ADD COLUMN     "switchboardFeed" TEXT;
