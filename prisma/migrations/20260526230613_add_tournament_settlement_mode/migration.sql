-- CreateEnum
CREATE TYPE "SettlementMode" AS ENUM ('OrganizerOnly', 'PlayerReported', 'Oracle');

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "settlementMode" "SettlementMode";

