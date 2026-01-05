/**
 * URL Parameter Utilities
 * 
 * Helper functions for working with URL parameters and routing in the B2B Portal
 */

/**
 * Get a URL parameter from the current URL
 * @param param - The parameter name to get
 * @returns The parameter value or null if not found
 */
export function getUrlParam(param: string): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
}

/**
 * Get all URL parameters as an object
 * @returns Object with all URL parameters
 */
export function getAllUrlParams(): Record<string, string> {
    const urlParams = new URLSearchParams(window.location.search);
    const params: Record<string, string> = {};

    urlParams.forEach((value, key) => {
        params[key] = value;
    });

    return params;
}

/**
 * Set a URL parameter without reloading the page
 * @param param - The parameter name
 * @param value - The parameter value
 */
export function setUrlParam(param: string, value: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set(param, value);
    window.history.pushState({}, '', url.toString());
}

/**
 * Remove a URL parameter without reloading the page
 * @param param - The parameter name to remove
 */
export function removeUrlParam(param: string): void {
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    window.history.pushState({}, '', url.toString());
}

/**
 * Get the current route from the URL hash
 * @returns The current route (without the #)
 */
export function getCurrentRoute(): string {
    return window.location.hash.slice(1);
}

/**
 * Navigate to a route using hash-based routing
 * @param route - The route to navigate to
 */
export function navigateToRoute(route: string): void {
    window.location.hash = route;
}

/**
 * Get URL parameters and parse them as typed values
 * Useful for getting settings from URL
 */
export function getTypedUrlParam<T = string>(
    param: string,
    type: 'string' | 'number' | 'boolean' | 'json' = 'string'
): T | null {
    const value = getUrlParam(param);

    if (value === null) {
        return null;
    }

    try {
        switch (type) {
            case 'number':
                const num = Number(value);
                return (isNaN(num) ? null : num) as T;

            case 'boolean':
                return (value.toLowerCase() === 'true') as T;

            case 'json':
                return JSON.parse(value) as T;

            case 'string':
            default:
                return value as T;
        }
    } catch (error) {
        console.error(`Error parsing URL param "${param}":`, error);
        return null;
    }
}

/**
 * Build a URL with parameters
 * @param baseUrl - The base URL
 * @param params - Object with parameters to add
 * @returns The complete URL with parameters
 */
export function buildUrl(baseUrl: string, params: Record<string, string | number | boolean>): string {
    const url = new URL(baseUrl, window.location.origin);

    Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
    });

    return url.toString();
}

/**
 * Example: Get settings from URL
 * 
 * Usage:
 * const settings = getSettingsFromUrl();
 * console.log(settings.theme); // 'dark'
 * console.log(settings.pageSize); // 25
 */
export function getSettingsFromUrl(): Record<string, any> {
    const settings: Record<string, any> = {};
    const urlParams = new URLSearchParams(window.location.search);

    // Common settings that might be passed via URL
    const settingKeys = [
        'theme',
        'pageSize',
        'sortBy',
        'filterBy',
        'view',
        'locale',
        'debug',
    ];

    settingKeys.forEach(key => {
        const value = urlParams.get(key);
        if (value !== null) {
            settings[key] = value;
        }
    });

    return settings;
}

/**
 * Parse a filter string from URL
 * Example: "status:active,role:admin" -> { status: 'active', role: 'admin' }
 */
export function parseFilterParam(filterString: string | null): Record<string, string> {
    if (!filterString) {
        return {};
    }

    const filters: Record<string, string> = {};

    filterString.split(',').forEach(filter => {
        const [key, value] = filter.split(':');
        if (key && value) {
            filters[key.trim()] = value.trim();
        }
    });

    return filters;
}

/**
 * Build a filter string for URL
 * Example: { status: 'active', role: 'admin' } -> "status:active,role:admin"
 */
export function buildFilterParam(filters: Record<string, string>): string {
    return Object.entries(filters)
        .map(([key, value]) => `${key}:${value}`)
        .join(',');
}
