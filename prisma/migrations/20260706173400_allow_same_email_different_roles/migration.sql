-- Drop the old uniqueness rule that blocked same email across different roles
DROP INDEX "User_shopId_email_key";

-- Allow the same email per shop as long as the role differs
CREATE UNIQUE INDEX "User_shopId_email_role_key" ON "User"("shopId", "email", "role");
