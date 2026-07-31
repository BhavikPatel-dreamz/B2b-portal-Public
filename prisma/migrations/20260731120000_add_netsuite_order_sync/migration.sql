-- CreateTable
CREATE TABLE "OrderSyncLog" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "runAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "mode" TEXT NOT NULL DEFAULT 'live',
  "externalId" TEXT,
  "reference" TEXT,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "orderName" TEXT,
  "orderId" TEXT,
  "company" TEXT,
  "message" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetsuiteAppSettings" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "syncStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NetsuiteAppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderSyncLog_shop_runAt_idx" ON "OrderSyncLog"("shop", "runAt");
CREATE INDEX "OrderSyncLog_shop_status_runAt_idx" ON "OrderSyncLog"("shop", "status", "runAt");
CREATE INDEX "OrderSyncLog_shop_action_runAt_idx" ON "OrderSyncLog"("shop", "action", "runAt");
CREATE INDEX "OrderSyncLog_shop_externalId_idx" ON "OrderSyncLog"("shop", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "NetsuiteAppSettings_shop_key" ON "NetsuiteAppSettings"("shop");
