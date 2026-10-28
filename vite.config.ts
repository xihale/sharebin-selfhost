import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import type { ServerResponse } from 'http'
import { getHtmlEntrypointForPath, getPasteIdForPath, HTML_ENTRYPOINTS } from './src/shared/routes'
import {
  buildRedirectLocation,
  redirectCacheControl,
  SHARE_LINK_REDIRECT_STATUS,
} from './src/shared/redirect'

// Packages loaded from webcache CDN via import map
const CDN_EXTERNAL = [
  'codemirror',
  '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/language',
  '@codemirror/search', '@codemirror/lint', '@codemirror/state', '@codemirror/view',
  '@codemirror/lang-cpp', '@codemirror/lang-css', '@codemirror/lang-go',
  '@codemirror/lang-html', '@codemirror/lang-java', '@codemirror/lang-javascript',
  '@codemirror/lang-jinja', '@codemirror/lang-json', '@codemirror/lang-less',
  '@codemirror/lang-liquid', '@codemirror/lang-markdown', '@codemirror/lang-php',
  '@codemirror/lang-python', '@codemirror/lang-rust', '@codemirror/lang-sass',
  '@codemirror/lang-sql', '@codemirror/lang-wast', '@codemirror/lang-xml',
  '@codemirror/lang-yaml', '@codemirror/lang-vue', '@codemirror/lang-angular',
  '@lezer/common', '@lezer/highlight', '@lezer/lr',
  '@lezer/cpp', '@lezer/css', '@lezer/go', '@lezer/html', '@lezer/java',
  '@lezer/javascript', '@lezer/json', '@lezer/markdown', '@lezer/php',
  '@lezer/python', '@lezer/rust', '@lezer/sass', '@lezer/xml', '@lezer/yaml',
  '@marijn/find-cluster-break',
  'crelt', 'style-mod', 'w3c-keyname',
]

// Import map: bare specifiers -> webcache CDN URLs
const CDN = 'https://npm.webcache.cn'
const IMPORT_MAP: Record<string, string> = {
  'codemirror': `${CDN}/codemirror@6.0.2/dist/index.js`,
  '@codemirror/autocomplete': `${CDN}/@codemirror/autocomplete@6.20.1/dist/index.js`,
  '@codemirror/commands': `${CDN}/@codemirror/commands@6.10.3/dist/index.js`,
  '@codemirror/language': `${CDN}/@codemirror/language@6.12.3/dist/index.js`,
  '@codemirror/search': `${CDN}/@codemirror/search@6.7.0/dist/index.js`,
  '@codemirror/lint': `${CDN}/@codemirror/lint@6.9.5/dist/index.js`,
  '@codemirror/state': `${CDN}/@codemirror/state@6.6.0/dist/index.js`,
  '@codemirror/view': `${CDN}/@codemirror/view@6.41.1/dist/index.js`,
  '@codemirror/lang-cpp': `${CDN}/@codemirror/lang-cpp@6.0.3/dist/index.js`,
  '@codemirror/lang-css': `${CDN}/@codemirror/lang-css@6.3.1/dist/index.js`,
  '@codemirror/lang-go': `${CDN}/@codemirror/lang-go@6.0.1/dist/index.js`,
  '@codemirror/lang-html': `${CDN}/@codemirror/lang-html@6.4.11/dist/index.js`,
  '@codemirror/lang-java': `${CDN}/@codemirror/lang-java@6.0.2/dist/index.js`,
  '@codemirror/lang-javascript': `${CDN}/@codemirror/lang-javascript@6.2.5/dist/index.js`,
  '@codemirror/lang-jinja': `${CDN}/@codemirror/lang-jinja@6.0.1/dist/index.js`,
  '@codemirror/lang-json': `${CDN}/@codemirror/lang-json@6.0.2/dist/index.js`,
  '@codemirror/lang-less': `${CDN}/@codemirror/lang-less@6.0.2/dist/index.js`,
  '@codemirror/lang-liquid': `${CDN}/@codemirror/lang-liquid@6.3.2/dist/index.js`,
  '@codemirror/lang-markdown': `${CDN}/@codemirror/lang-markdown@6.5.0/dist/index.js`,
  '@codemirror/lang-php': `${CDN}/@codemirror/lang-php@6.0.2/dist/index.js`,
  '@codemirror/lang-python': `${CDN}/@codemirror/lang-python@6.2.1/dist/index.js`,
  '@codemirror/lang-rust': `${CDN}/@codemirror/lang-rust@6.0.2/dist/index.js`,
  '@codemirror/lang-sass': `${CDN}/@codemirror/lang-sass@6.0.2/dist/index.js`,
  '@codemirror/lang-sql': `${CDN}/@codemirror/lang-sql@6.10.0/dist/index.js`,
  '@codemirror/lang-wast': `${CDN}/@codemirror/lang-wast@6.0.2/dist/index.js`,
  '@codemirror/lang-xml': `${CDN}/@codemirror/lang-xml@6.1.0/dist/index.js`,
  '@codemirror/lang-yaml': `${CDN}/@codemirror/lang-yaml@6.1.3/dist/index.js`,
  '@codemirror/lang-vue': `${CDN}/@codemirror/lang-vue@0.1.3/dist/index.js`,
  '@codemirror/lang-angular': `${CDN}/@codemirror/lang-angular@0.1.4/dist/index.js`,
  '@lezer/common': `${CDN}/@lezer/common@1.5.2/dist/index.js`,
  '@lezer/highlight': `${CDN}/@lezer/highlight@1.2.3/dist/index.js`,
  '@lezer/lr': `${CDN}/@lezer/lr@1.4.10/dist/index.js`,
  '@lezer/cpp': `${CDN}/@lezer/cpp@1.1.5/dist/index.js`,
  '@lezer/css': `${CDN}/@lezer/css@1.3.3/dist/index.js`,
  '@lezer/go': `${CDN}/@lezer/go@1.0.1/dist/index.js`,
  '@lezer/html': `${CDN}/@lezer/html@1.3.13/dist/index.js`,
  '@lezer/java': `${CDN}/@lezer/java@1.1.3/dist/index.js`,
  '@lezer/javascript': `${CDN}/@lezer/javascript@1.5.4/dist/index.js`,
  '@lezer/json': `${CDN}/@lezer/json@1.0.3/dist/index.js`,
  '@lezer/markdown': `${CDN}/@lezer/markdown@1.6.3/dist/index.js`,
  '@lezer/php': `${CDN}/@lezer/php@1.0.5/dist/index.js`,
  '@lezer/python': `${CDN}/@lezer/python@1.1.18/dist/index.js`,
  '@lezer/rust': `${CDN}/@lezer/rust@1.0.2/dist/index.js`,
  '@lezer/sass': `${CDN}/@lezer/sass@1.1.0/dist/index.js`,
  '@lezer/xml': `${CDN}/@lezer/xml@1.0.6/dist/index.js`,
  '@lezer/yaml': `${CDN}/@lezer/yaml@1.0.4/dist/index.js`,
  '@marijn/find-cluster-break': `${CDN}/@marijn/find-cluster-break@1.0.2/src/index.js`,
  'crelt': `${CDN}/crelt@1.0.6/index.js`,
  'style-mod': `${CDN}/style-mod@4.1.3/src/style-mod.js`,
  'w3c-keyname': `${CDN}/w3c-keyname@2.2.8/index.js`,
}

const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000'

function getFallbackTarget(url: string): { html: string; status: number } | null {
  const html = getHtmlEntrypointForPath(url)
  if (html) return { html, status: 200 }

  return { html: HTML_ENTRYPOINTS.notFound, status: 404 }
}

/**
 * Dev/preview parity with the Bun server: ask the API whether `/:id` is a URL
 * paste and answer with the same 308 instead of loading the viewer SPA.
 * Returns false (→ fall through to the SPA) when the API says code/404/down.
 */
async function redirectPasteLink(
  pasteId: string,
  search: string,
  res: ServerResponse,
): Promise<boolean> {
  try {
    const response = await fetch(`${apiTarget}/api/paste/${encodeURIComponent(pasteId)}`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return false

    const data = (await response.json()) as { type?: string; url?: string; expiresIn?: number }
    if (data.type !== 'url' || !data.url) return false

    res.statusCode = SHARE_LINK_REDIRECT_STATUS
    res.setHeader('Location', buildRedirectLocation(data.url, search))
    res.setHeader('Cache-Control', redirectCacheControl((data.expiresIn ?? 0) * 1000))
    res.end()
    return true
  } catch {
    return false
  }
}

/** Split a raw request target into pathname + query string. */
function splitRequestTarget(rawUrl: string): { pathname: string; search: string } {
  const queryIndex = rawUrl.indexOf('?')
  if (queryIndex === -1) return { pathname: rawUrl, search: '' }
  return { pathname: rawUrl.slice(0, queryIndex), search: rawUrl.slice(queryIndex) }
}

function spaFallback(): Plugin {
  return {
    name: 'spa-fallback',
    configureServer(server: ViteDevServer) {
      // Pre-hook: runs BEFORE Vite's built-in middleware stack
      server.middlewares.use(async (req, res, next) => {
        const { pathname, search } = splitRequestTarget(req.url || '/')

        // Skip API calls, Vite internals, and anything with a file extension
        if (
          pathname.startsWith('/api/') ||
          pathname.startsWith('/@') ||
          pathname.startsWith('/node_modules/') ||
          /\.\w+$/.test(pathname)
        ) {
          return next()
        }

        const pasteId = getPasteIdForPath(pathname)
        if (pasteId && (req.method === 'GET' || req.method === 'HEAD')) {
          if (await redirectPasteLink(pasteId, search, res)) return
        }

        const target = getFallbackTarget(pathname)
        if (!target) return next()

        try {
          const htmlPath = resolve(__dirname, 'frontend', target.html)
          const html = readFileSync(htmlPath, 'utf-8')
          // Use the original URL so Vite's HMR client connects correctly
          const transformed = await server.transformIndexHtml(url, html)
          res.setHeader('Content-Type', 'text/html')
          res.statusCode = target.status
          res.end(transformed)
        } catch (e) {
          console.error('[spa-fallback] Error:', e)
          return next()
        }
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname, search } = splitRequestTarget(req.url || '/')
        if (pathname.startsWith('/api/') || pathname.startsWith('/@') || pathname.includes('.')) {
          return next()
        }

        const pasteId = getPasteIdForPath(pathname)
        if (pasteId && (req.method === 'GET' || req.method === 'HEAD')) {
          if (await redirectPasteLink(pasteId, search, res)) return
        }

        const target = getFallbackTarget(pathname)
        if (!target) return next()

        try {
          const htmlPath = resolve(__dirname, 'dist', target.html)
          const content = readFileSync(htmlPath, 'utf-8')
          res.setHeader('Content-Type', 'text/html')
          res.statusCode = target.status
          res.end(content)
        } catch {
          return next()
        }
      })
    },
  }
}

export default defineConfig({
  root: resolve(__dirname, 'frontend'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'frontend/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'frontend/index.html'),
        viewer: resolve(__dirname, 'frontend/viewer.html'),
        notFound: resolve(__dirname, 'frontend/404.html'),
      },
      external: CDN_EXTERNAL,
    },
    target: 'es2022',
    minify: true,
  },
  plugins: [spaFallback()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3001,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
