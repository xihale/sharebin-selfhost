export const HTML_ENTRYPOINTS = {
  index: 'index.html',
  viewer: 'viewer.html',
  notFound: '404.html',
} as const

export const PASTE_ID_PATTERN = /^[a-zA-Z0-9]{2,10}$/

export function isPasteId(value: string): boolean {
  return PASTE_ID_PATTERN.test(value)
}

/** Extract a paste ID from a pathname (`/abc` → `abc`), or null if it isn't one. */
export function getPasteIdForPath(pathname: string): string | null {
  const pasteId = pathname.startsWith('/') ? pathname.slice(1) : pathname
  return isPasteId(pasteId) ? pasteId : null
}

export function getHtmlEntrypointForPath(pathname: string): string | null {
  if (pathname === '/') return HTML_ENTRYPOINTS.index
  if (getPasteIdForPath(pathname)) return HTML_ENTRYPOINTS.viewer

  return null
}
