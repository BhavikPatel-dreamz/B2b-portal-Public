/**
 * Permission and Role-Based Access Control (RBAC) Server Utilities
 *
 * This module provides server-side functions to check user permissions and roles
 * for API proxy routes based on the company structure and role assignments.
 */

import { getCustomerCompanyInfo } from "./b2b-customer.server";

// Define user role types
export type UserRole = 'Company Admin' | 'Location Admin' | 'Ordering Only' | 'Member';

// Define permission types that align with useCurrentUser hook
export interface UserPermissions {
    canManageUsers: boolean;
    canManageLocations: boolean;
    canManageOrders: boolean;
    canViewReports: boolean;
    canManageCredit: boolean;
    canManageSettings: boolean;
    canAccessAllLocations: boolean;
    assignedLocationIds: string[];
}

// Role assignment details
export interface RoleAssignment {
    role: string;
    locationId?: string;
    locationName?: string;
}

// User context with permissions
export interface UserContext {
    customerId: string;
    customerName: string;
    customerEmail: string;
    companyId: string;
    companyName: string;
    roles: string[];
    roleAssignments: RoleAssignment[];
    permissions: UserPermissions;
    isMainContact: boolean;
}

/**
 * Calculate user permissions based on roles and company status
 * This logic mirrors the frontend useCurrentUser hook
 */
export function calculatePermissions(
    roles: string[],
    roleAssignments: RoleAssignment[],
    isMainContact: boolean
): UserPermissions {
    const roleNames = roles.map(r => r.toLowerCase());
    const hasCompanyAdmin = roleNames.some(r => r.includes('company admin') || r.includes('admin'));
    const hasLocationAdmin = roleNames.some(r => r.includes('location admin'));

    // Get all assigned location IDs
    const assignedLocationIds = roleAssignments
        .filter(ra => ra.locationId)
        .map(ra => ra.locationId as string);

    return {
        // Company admins and main contacts can manage users
        canManageUsers: hasCompanyAdmin || isMainContact,

        // Company admins and main contacts can manage locations
        canManageLocations: hasCompanyAdmin || isMainContact,

        // Company admins, location admins, and main contacts can manage orders
        canManageOrders: hasCompanyAdmin || hasLocationAdmin || isMainContact,

        // All users can view reports (but data is filtered by permissions)
        canViewReports: true,

        // Company admins and main contacts can manage credit
        canManageCredit: hasCompanyAdmin || isMainContact,

        // Company admins and main contacts can manage settings
        canManageSettings: hasCompanyAdmin || isMainContact,

        // Company admins and main contacts can access all locations
        canAccessAllLocations: hasCompanyAdmin || isMainContact,

        // Store assigned location IDs
        assignedLocationIds,
    };
}

/**
 * Get user context with roles and permissions
 * This function fetches the user's company info and calculates their permissions
 *
 * @param customerId - The Shopify customer ID
 * @param shop - The shop domain
 * @param accessToken - The Shopify access token
 * @returns UserContext with permissions
 * @throws Error if user has no company or cannot fetch data
 */
export async function getUserContext(
    customerId: string,
    shop: string,
    accessToken: string
): Promise<UserContext> {
    // Fetch customer company information
    const companyInfo = await getCustomerCompanyInfo(customerId, shop, accessToken);

    if (!companyInfo.hasCompany || !companyInfo.companies || companyInfo.companies.length === 0) {
        throw new Error("No company found for this customer");
    }

    // Use the first company (most users will only have one)
    const company = companyInfo.companies[0];

    // Check if this user is the main contact
    const isMainContact = company.mainContact?.id === `gid://shopify/Customer/${customerId}`;

    // Calculate permissions
    const permissions = calculatePermissions(
        company.roles || [],
        company.roleAssignments || [],
        isMainContact
    );

    return {
        customerId,
        customerName: companyInfo.customerName || '',
        customerEmail: companyInfo.customerEmail || '',
        companyId: company.companyId,
        companyName: company.companyName,
        roles: company.roles || [],
        roleAssignments: company.roleAssignments || [],
        permissions,
        isMainContact,
    };
}

/**
 * Check if user has a specific permission
 *
 * @param userContext - The user context with permissions
 * @param permission - The permission key to check
 * @returns boolean indicating if user has the permission
 */
export function hasPermission(
    userContext: UserContext,
    permission: keyof Omit<UserPermissions, 'assignedLocationIds'>
): boolean {
    const value = userContext.permissions[permission];
    return typeof value === 'boolean' ? value : false;
}

/**
 * Check if user has a specific role
 *
 * @param userContext - The user context with roles
 * @param role - The role to check (case-insensitive)
 * @returns boolean indicating if user has the role
 */
export function hasRole(userContext: UserContext, role: UserRole | string): boolean {
    return userContext.roles.some(r => r.toLowerCase() === role.toLowerCase());
}

/**
 * Check if user can access a specific location
 *
 * @param userContext - The user context with permissions
 * @param locationId - The location ID to check
 * @returns boolean indicating if user can access the location
 */
export function canAccessLocation(userContext: UserContext, locationId: string): boolean {
    if (userContext.permissions.canAccessAllLocations) {
        return true;
    }
    return userContext.permissions.assignedLocationIds.includes(locationId);
}

/**
 * Validate that user has required permission
 * Throws a Response error if permission check fails
 *
 * @param userContext - The user context with permissions
 * @param permission - The required permission
 * @param errorMessage - Optional custom error message
 * @throws Response with 403 if permission denied
 */
export function requirePermission(
    userContext: UserContext,
    permission: keyof Omit<UserPermissions, 'assignedLocationIds'>,
    errorMessage?: string
): void {
    if (!hasPermission(userContext, permission)) {
        const message = errorMessage || `Access denied: ${permission} permission required`;
        throw Response.json(
            { error: message, requiredPermission: permission },
            { status: 403 }
        );
    }
}

/**
 * Validate that user has required role
 * Throws a Response error if role check fails
 *
 * @param userContext - The user context with roles
 * @param role - The required role
 * @param errorMessage - Optional custom error message
 * @throws Response with 403 if role check fails
 */
export function requireRole(
    userContext: UserContext,
    role: UserRole | string,
    errorMessage?: string
): void {
    if (!hasRole(userContext, role)) {
        const message = errorMessage || `Access denied: ${role} role required`;
        throw Response.json(
            { error: message, requiredRole: role },
            { status: 403 }
        );
    }
}

/**
 * Validate that user can access a specific location
 * Throws a Response error if location access check fails
 *
 * @param userContext - The user context with permissions
 * @param locationId - The location ID to check
 * @param errorMessage - Optional custom error message
 * @throws Response with 403 if location access denied
 */
export function requireLocationAccess(
    userContext: UserContext,
    locationId: string,
    errorMessage?: string
): void {
    if (!canAccessLocation(userContext, locationId)) {
        const message = errorMessage || `Access denied: You do not have access to this location`;
        throw Response.json(
            { error: message, locationId },
            { status: 403 }
        );
    }
}

/**
 * Validate multiple permissions (user must have ALL)
 * Throws a Response error if any permission check fails
 *
 * @param userContext - The user context with permissions
 * @param permissions - Array of required permissions
 * @param errorMessage - Optional custom error message
 * @throws Response with 403 if any permission denied
 */
export function requireAllPermissions(
    userContext: UserContext,
    permissions: Array<keyof Omit<UserPermissions, 'assignedLocationIds'>>,
    errorMessage?: string
): void {
    const missingPermissions = permissions.filter(p => !hasPermission(userContext, p));

    if (missingPermissions.length > 0) {
        const message = errorMessage || `Access denied: Missing permissions: ${missingPermissions.join(', ')}`;
        throw Response.json(
            { error: message, missingPermissions },
            { status: 403 }
        );
    }
}

/**
 * Validate at least one permission (user must have ANY)
 * Throws a Response error if no permissions match
 *
 * @param userContext - The user context with permissions
 * @param permissions - Array of permissions (user needs at least one)
 * @param errorMessage - Optional custom error message
 * @throws Response with 403 if no permissions match
 */
export function requireAnyPermission(
    userContext: UserContext,
    permissions: Array<keyof Omit<UserPermissions, 'assignedLocationIds'>>,
    errorMessage?: string
): void {
    const hasAny = permissions.some(p => hasPermission(userContext, p));

    if (!hasAny) {
        const message = errorMessage || `Access denied: One of these permissions required: ${permissions.join(', ')}`;
        throw Response.json(
            { error: message, requiredPermissions: permissions },
            { status: 403 }
        );
    }
}
