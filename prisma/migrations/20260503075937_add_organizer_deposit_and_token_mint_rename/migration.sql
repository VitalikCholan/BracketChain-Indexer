/*
  Warnings:

  - You are about to drop the column `usdcMint` on the `Tournament` table. All the data in the column will be lost.
  - Added the required column `tokenMint` to the `Tournament` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "PayoutKind" ADD VALUE 'OrganizerRefund';

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "usdcMint",
ADD COLUMN     "organizerDeposit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tokenMint" TEXT NOT NULL;
