/**
 * Global configuration for the B2B Portal
 * Handles base URLs, asset paths, and proxy-specific settings
 */



export const APP_CONFIG = {
  // Base URL of your app (where it's actually hosted)
  BASE_URL: '/apps/b2b-portal/registration',

  // Shopify API Key
  API_KEY: process.env.SHOPIFY_API_KEY || '',

  // App Proxy settings (must match shopify.app.toml)
  PROXY: {
    PREFIX: 'apps',
    SUBPATH: 'b2b-portal',
  },
};

/**
 * Check if the current request is coming through Shopify's app proxy
 */
export function isProxyRequest(request: Request): boolean {
  const url = new URL(request.url);

  // Check if hostname contains myshopify.com
  if (url.hostname.includes('myshopify.com')) {
    return true;
  }

  if ((url.searchParams.get("path_prefix")===`/${APP_CONFIG.PROXY.PREFIX}/${APP_CONFIG.PROXY.SUBPATH}`))
   {
    return true;
  }


  return false;
}

/**
 * Get the base URL for assets based on request context
 * Returns the app's base URL if it's a proxy request, otherwise empty string (relative paths)
 */
export function getAssetBaseUrl(request: Request): string {
  return isProxyRequest(request) ? APP_CONFIG.BASE_URL : '';
}

/**
 * Get full asset URL
 * Prepends base URL if it's a proxy request
 */
export function getAssetUrl(request: Request, assetPath: string): string {
  const baseUrl = getAssetBaseUrl(request);

  // Remove leading slash from assetPath if present
  const cleanPath = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;

  if (baseUrl) {
    return `${baseUrl}/${cleanPath}`;
  }

  return `/${cleanPath}`;
}

/**
 * Common loader data that includes configuration
 * Use this in your route loaders to provide consistent config to components
 */
export function getCommonLoaderData(request: Request) {
  const isProxy = isProxyRequest(request);
  const baseUrl = getAssetBaseUrl(request);
  const AppbaseUrl = `/${APP_CONFIG.PROXY.PREFIX}/${APP_CONFIG.PROXY.SUBPATH}`;

  return {
    config: {
      baseUrl,
      AppbaseUrl,
      isProxyRequest: isProxy,
      apiKey: APP_CONFIG.API_KEY,
    },
  };
}
