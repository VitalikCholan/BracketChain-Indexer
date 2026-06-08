-- CreateTable
CREATE TABLE "SteamIdentity" (
    "identityHash" TEXT NOT NULL,
    "steamId64" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SteamIdentity_pkey" PRIMARY KEY ("identityHash")
);

-- CreateIndex
CREATE INDEX "SteamIdentity_wallet_idx" ON "SteamIdentity"("wallet");
