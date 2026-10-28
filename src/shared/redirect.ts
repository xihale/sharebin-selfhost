/**
 * Share-link redirect helpers.
 * Pure functions shared by the Bun server and the Vite dev/preview servers so
 * both answer `/ :id` with the same 308 semantics.
 */

/** Permanent redirect that preserves the request method (RFC 9110 §15.4.9). */
export const SHARE_LINK_REDIRECT_STATUS = 308

/**
 * Append the share-link query string to the target URL.
 * Target query parameters are kept; incoming ones are appended. The fragment
 * stays last, as required by RFC 3986 §4.1.
 */
export function buildRedirectLocation(target: string, search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (!query) return target

  const hashIndex = target.indexOf('#')
  const base = hashIndex === -1 ? target : target.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : target.slice(hashIndex)
  const separator = base.includes('?') ? '&' : '?'

  return `${base}${separator}${query}${hash}`
}

/**
 * Cache the redirect only as long as the paste is valid, so an expired link
 * does not keep redirecting from a client-side cache.
 */
export function redirectCacheControl(remainingMs: number): string {
  const seconds = Math.max(1, Math.floor(remainingMs / 1000))
  return `public, max-age=${seconds}`
}
