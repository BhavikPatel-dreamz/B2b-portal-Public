ALTER TABLE "B2BOrder"
ADD COLUMN "orderNumber" TEXT,
ADD COLUMN "customerName" TEXT,
ADD COLUMN "customerEmail" TEXT,
ADD COLUMN "customerId" TEXT,
ADD COLUMN "poNumber" TEXT,
ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "shippingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "paymentLink" TEXT,
ADD COLUMN "paymentLinkToken" TEXT,
ADD COLUMN "paymentLinkAt" TIMESTAMP(3),
ADD COLUMN "paymentLinkSentAt" TIMESTAMP(3);

CREATE TABLE "B2BOrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "productTitle" TEXT NOT NULL,
  "variantId" TEXT,
  "variantTitle" TEXT,
  "sku" TEXT,
  "image" TEXT,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(14,2) NOT NULL,
  "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "lineTotal" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "B2BOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderActivity" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderActivity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "B2BOrder_paymentLinkToken_key" ON "B2BOrder"("paymentLinkToken");
CREATE INDEX "B2BOrder_customerEmail_idx" ON "B2BOrder"("customerEmail");
CREATE INDEX "B2BOrder_orderNumber_idx" ON "B2BOrder"("orderNumber");
CREATE INDEX "B2BOrderItem_orderId_idx" ON "B2BOrderItem"("orderId");
CREATE INDEX "OrderActivity_orderId_createdAt_idx" ON "OrderActivity"("orderId", "createdAt");
CREATE INDEX "OrderActivity_userId_idx" ON "OrderActivity"("userId");

ALTER TABLE "B2BOrderItem" ADD CONSTRAINT "B2BOrderItem_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "B2BOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderActivity" ADD CONSTRAINT "OrderActivity_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "B2BOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderActivity" ADD CONSTRAINT "OrderActivity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
