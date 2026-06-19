CREATE TABLE "Quote" (
  "id" TEXT NOT NULL,
  "quoteNumber" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "salesAgentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "secureToken" TEXT NOT NULL,
  "customerUserId" TEXT,
  "customerShopifyId" TEXT,
  "customerEmail" TEXT NOT NULL,
  "customerFirstName" TEXT,
  "customerLastName" TEXT,
  "currencyCode" TEXT NOT NULL DEFAULT 'USD',
  "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountType" TEXT NOT NULL DEFAULT 'FIXED_AMOUNT',
  "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "shippingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "customerNotes" TEXT,
  "internalNotes" TEXT,
  "customerComments" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "viewedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "convertedAt" TIMESTAMP(3),
  "convertedOrderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuoteItem" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "productId" TEXT,
  "productTitle" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "variantTitle" TEXT,
  "sku" TEXT,
  "image" TEXT,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(14,2) NOT NULL,
  "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalPrice" DECIMAL(14,2) NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuoteActivity" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "userId" TEXT,
  "companyId" TEXT NOT NULL,
  "customerEmail" TEXT,
  "action" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuoteActivity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Quote_quoteNumber_key" ON "Quote"("quoteNumber");
CREATE UNIQUE INDEX "Quote_secureToken_key" ON "Quote"("secureToken");
CREATE INDEX "Quote_shopId_createdAt_idx" ON "Quote"("shopId", "createdAt");
CREATE INDEX "Quote_companyId_status_idx" ON "Quote"("companyId", "status");
CREATE INDEX "Quote_salesAgentId_idx" ON "Quote"("salesAgentId");
CREATE INDEX "Quote_customerEmail_idx" ON "Quote"("customerEmail");
CREATE INDEX "Quote_expiresAt_idx" ON "Quote"("expiresAt");
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");
CREATE INDEX "QuoteItem_variantId_idx" ON "QuoteItem"("variantId");
CREATE INDEX "QuoteActivity_quoteId_createdAt_idx" ON "QuoteActivity"("quoteId", "createdAt");
CREATE INDEX "QuoteActivity_companyId_createdAt_idx" ON "QuoteActivity"("companyId", "createdAt");
CREATE INDEX "QuoteActivity_userId_idx" ON "QuoteActivity"("userId");
CREATE INDEX "QuoteActivity_action_idx" ON "QuoteActivity"("action");

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_salesAgentId_fkey" FOREIGN KEY ("salesAgentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteActivity" ADD CONSTRAINT "QuoteActivity_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteActivity" ADD CONSTRAINT "QuoteActivity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
