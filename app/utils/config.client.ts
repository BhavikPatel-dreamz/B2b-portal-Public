/**
 * Client-side configuration utilities
 * Use these in your React components
 */

/**
 * Get asset URL with proper base path
 * This works on the client side by checking the current location
 */
export function getAssetUrl(assetPath: string): string {
  // Check if we're in a proxy context
  const isProxy = typeof window !== 'undefined' &&
    (window.location.hostname.includes('myshopify.com') ||
     window.location.pathname.startsWith('/apps/b2b-portal'));

  // If proxy, use absolute URL to your app
  if (isProxy) {
    const baseUrl = 'https://b2b.dynamicdreamz.com';
    const cleanPath = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    return `${baseUrl}/${cleanPath}`;
  }

  // Otherwise use relative path
  return assetPath;
}

/**
 * Check if current page is loaded via proxy
 */
export function isProxyContext(): boolean {
  if (typeof window === 'undefined') return false;

  return (
    window.location.hostname.includes('myshopify.com') ||
    window.location.pathname.startsWith('/apps/b2b-portal')
  );
}
