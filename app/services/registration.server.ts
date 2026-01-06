import prisma from "../db.server";
import { Prisma, UserStatus } from "@prisma/client";

export interface CreateRegistrationInput {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  businessType: string;
  website?: string | null;
  additionalInfo?: string | null;
  shopId: string;
  shopifyCustomerId?: string | null;
}

export interface UpdateRegistrationInput {
  status?: UserStatus;
  reviewedBy?: string;
  reviewNotes?: string;
  reviewedAt?: Date;
  workflowCompleted?: boolean;
}

/**
 * Create a new registration submission
 */
export async function createRegistration(data: CreateRegistrationInput) {
  return await prisma.registrationSubmission.create({
    data: {
      companyName: data.companyName,
      contactName: data.contactName,
      email: data.email,
      phone: data.phone,
      businessType: data.businessType,
      website: data.website,
      additionalInfo: data.additionalInfo,
      shopId: data.shopId,
      status: "PENDING",
      shopifyCustomerId: data.shopifyCustomerId,
    },
  });
}

/**
 * Get registration by email and shop
 */
export async function getRegistrationByEmail(email: string, shopId: string) {
  return await prisma.registrationSubmission.findFirst({
    where: {
      email,
      shopId,
    },
  });
}

/**
 * Get registration by ID
 */
export async function getRegistrationById(id: string) {
  return await prisma.registrationSubmission.findUnique({
    where: { id },
    include: {
      shop: true,
    },
  });
}

/**
 * Get all registrations for a shop
 */
export async function getRegistrationsByShop(
  shopId: string,
  options?: {
    status?: UserStatus;
    orderBy?: Prisma.RegistrationSubmissionOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  return await prisma.registrationSubmission.findMany({
    where: {
      shopId,
      ...(options?.status && { status: options.status }),
    },
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
  });
}

/**
 * Update a registration
 */
export async function updateRegistration(
  id: string,
  data: UpdateRegistrationInput,
) {
  return await prisma.registrationSubmission.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

/**
 * Delete a registration
 */
export async function deleteRegistration(id: string) {
  return await prisma.registrationSubmission.delete({
    where: { id },
  });
}

/**
 * Count registrations for a shop
 */
export async function countRegistrations(
  shopId: string,
  status?: UserStatus,
) {
  return await prisma.registrationSubmission.count({
    where: {
      shopId,
      ...(status && { status }),
    },
  });
}
