/**
 * Frontend configuration center
 * All CDN URLs, API paths, and constants are managed here
 */

// ==================== CDN Configuration ====================
const CDN_BASE = 'https://npm.webcache.cn'

export const CDN: Record<string, string | { js: string; css: string }> = {
  base: CDN_BASE,
  html2canvas: `${CDN_BASE}/html2canvas@1.4.1/dist/html2canvas.min.js`,
  flourite: `${CDN_BASE}/flourite@1.5.0/dist/flourite.min.js`,
}

// ==================== API Configuration ====================
export const API = {
  config: '/api/config',
  create: '/api/create',
  paste: (id: string): string => `/api/paste/${encodeURIComponent(id)}`,
}

// ==================== App Configuration ====================
let _config: AppConfig | null = null

/**
 * Initialize configuration from backend
 * Fetches /api/config and merges with defaults
 */
export async function initConfig(): Promise<AppConfig> {
  try {
    const res = await fetch(API.config)
    if (res.ok) {
      const data: Partial<AppConfig> = await res.json()
      _config = {
        maxContentSize: data.maxContentSize || 100 * 1024, // 100KB default
        expirationDays: data.expirationDays || 7,
        cdnBase: data.cdnBase || CDN_BASE,
        ...data,
      }
    }
  } catch (e) {
    console.warn('Failed to load config, using defaults:', e)
  }

  // Fallback defaults
  if (!_config) {
    _config = {
      maxContentSize: 100 * 1024,
      expirationDays: 7,
      cdnBase: CDN_BASE,
    }
  }

  return _config
}

/**
 * Get current configuration
 */
export function getConfig(): AppConfig | null {
  return _config
}

// ==================== Constants ====================
export const MAX_CONTENT_SIZE = 100 * 1024 // 100KB
export const EXPIRATION_DAYS = 7
