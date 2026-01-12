export async function createUser(data: CreateUserInput) {
  return await prisma.user.create({
    data: {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      password: data.password,
      role: data.role || "STORE_USER",
      status: data.status || "PENDING",
      shopId: data.shopId,
      companyId: data.companyId,
      companyRole: data.companyRole,
      shopifyCustomerId: data.shopifyCustomerId,
      isActive: true,
      userCreditLimit: data.userCreditLimit || 0,
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Get user by ID with shop isolation
 */
export async function getUserById(id: string, shopId: string) {
  return await prisma.user.findUnique({
    where: {
      id,
      // Include shopId for proper tenant isolation
      shopId
    },
    include: {
      shop: true,
      company: true,
      sessions: true,
    },
  });
}

/**
 * Get user by ID (alternative - for cases where you need to find across shops)
 */
export async function getUserByIdGlobal(id: string) {
  return await prisma.user.findUnique({
    where: { id },
    include: {
      shop: true,
      company: true,
      sessions: true,
    },
  });
}

/**
 * Get user by email within a specific shop
 */
export async function getUserByEmail(email: string, shopId: string) {
  return await prisma.user.findUnique({
    where: {
      shopId_email: {
        shopId,
        email,
      },
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Get users by company within a shop
 */
export async function getUsersByCompany(companyId: string, shopId: string) {
  return await prisma.user.findMany({
    where: {
      companyId,
      shopId,
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Get users by shop
 */
export async function getUsersByShop(shopId: string) {
  return await prisma.user.findMany({
    where: {
      shopId,
    },
    include: {
      shop: true,
      company: true,
    },
  });
}
