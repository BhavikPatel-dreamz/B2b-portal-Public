import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const store = await prisma.store.findUnique({ where: { shopDomain: "findash-shipping-15.myshopify.com" } });
  if (!store) { console.log("Store not found"); return; }
  const companies = await prisma.companyAccount.findMany({ where: { shopId: store.id }, include: { users: true } });
  console.log(JSON.stringify(companies.map(c => ({ name: c.name, users: c.users.length, activeUsers: c.users.filter(u => u.isActive).length, usersDetails: c.users.map(u => ({ email: u.email, isActive: u.isActive, status: u.status })) })), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
