-- CreateEnum
CREATE TYPE "Game" AS ENUM ('Manual', 'Dota2', 'Cs2Faceit', 'Valorant', 'LoL');

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "game" "Game";
