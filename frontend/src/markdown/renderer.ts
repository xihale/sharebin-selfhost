/**
 * Unified Markdown renderer for ShareBin
 * Eliminates the duplicated markdown rendering logic
 * Used by both editor preview and viewer
 *
 * Rendering stack (bundled with Vite):
 *   markdown — marked
 *   sanitizer — DOMPurify
 *   math — KaTeX (only when content contains math)
 *   diagrams — Pele (Mermaid syntax → SVG, themed via CSS variables)
 */

// marked/KaTeX/DOMPurify/Pele total well over 1 MB minified. Static imports
// would put all of it into every entry chunk (editor, viewer, 404), so the
// four modules are code-split via dynamic import and fetched on first render.
// The specifiers are static; only the load timing is deferred.
import type { Marked, MarkedExtension } from 'marked'
import type { DOMPurify } from 'dompurify'
import type { KatexOptions } from 'katex'
import type { Mounted } from 'pele'
import { icon } from '../icons.js'
import { showToast } from '../ui/toast.js'
import { normalizeLanguageId, renderStaticHighlightedCode } from '../highlight/shiki.js'

// ==================== State ====================

// KaTeX module value, kept for the math extension renderer below. Typed
// structurally because katex exports its instance as an anonymous const.
let _katex: { renderToString: (tex: string, options?: KatexOptions) => string } | null = null
// Own marked instance (not the shared `marked` singleton) so renderer and
// extension registration stay local to this module
let _marked: Marked | null = null
let _mathExtensionRegistered = false

// Live Pele mounts per markdown container, so re-renders can stop the old
// ResizeObservers before replacing the DOM
const _mountedDiagrams = new WeakMap<HTMLElement, Mounted[]>()

// ==================== Renderer ====================

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function createMarked(MarkedClass: new (...args: MarkedExtension[]) => Marked): Marked {
  return new MarkedClass({
    gfm: true,
    breaks: true,
    renderer: {
      code(token) {
        const source = String(token.text ?? '')
        const language = normalizeLanguageId(token.lang || 'plaintext')
        if (language === 'mermaid') {
          return `<div class="mermaid">${escapeHtml(source)}</div>`
        }
        return `<div class="code-block-wrapper">
                <button class="copy-snippet-btn">${icon('copy')}</button>
                <pre class="shiki-static shiki-static-line-numbers language-${language}" data-language="${language}"><code>${escapeHtml(source)}</code></pre>
              </div>`
      },
    },
  })
}

// ==================== Math (KaTeX) ====================

interface MathToken {
  type: 'math'
  raw: string
  text: string
  displayMode: boolean
}

// Inline math: content may not start or end with whitespace, and the closing
// '$' may not be followed by a digit, so prices like "$5 and $6" stay literal
const INLINE_MATH_RULE = /^\$(?=\S)((?:\\.|[^\\$])+?)(?<!\s)\$(?!\d)/
const INLINE_DISPLAY_RULE = /^\$\$((?:\\.|[^\\$])+?)\$\$/
const PAREN_MATH_RULE = /^\\\(([\s\S]+?)\\\)/
const BRACKET_MATH_RULE = /^\\\[([\s\S]+?)\\\]/

// Inline-level tokenizer so math is extracted before marked's escape/emphasis
// rules can mangle it (e.g. "\\n" -> "\", "\[" -> "[", "_x_" -> italics)
const mathExtension = {
  name: 'math',
  level: 'inline' as const,
  start(src: string): number | undefined {
    const indices = [src.indexOf('$'), src.indexOf('\\('), src.indexOf('\\[')].filter(i => i !== -1)
    return indices.length > 0 ? Math.min(...indices) : undefined
  },
  tokenizer(src: string): MathToken | undefined {
    const bracket = BRACKET_MATH_RULE.exec(src)
    if (bracket) return { type: 'math', raw: bracket[0], text: bracket[1].trim(), displayMode: true }
    const display = INLINE_DISPLAY_RULE.exec(src)
    if (display) return { type: 'math', raw: display[0], text: display[1].trim(), displayMode: true }
    const paren = PAREN_MATH_RULE.exec(src)
    if (paren) return { type: 'math', raw: paren[0], text: paren[1].trim(), displayMode: false }
    const inline = INLINE_MATH_RULE.exec(src)
    if (inline) return { type: 'math', raw: inline[0], text: inline[1], displayMode: false }
    return undefined
  },
  renderer(token: MathToken): string {
    if (!_katex) return escapeHtml(token.raw)
    try {
      return _katex.renderToString(token.text, { displayMode: token.displayMode, throwOnError: false, strict: false })
    } catch {
      return escapeHtml(token.raw)
    }
  },
}

// ==================== Diagrams (Pele) ====================

/**
 * Mount every mermaid fence in the container with Pele. Pele re-renders on
 * container resize, shows parse errors inline, and themes through the
 * --pele-* CSS variables (see style.css), so theme switches need no re-render.
 */
async function mountDiagrams(container: HTMLElement, dompurify: DOMPurify): Promise<void> {
  const diagramBlocks = container.querySelectorAll<HTMLElement>('.mermaid')
  for (const mounted of _mountedDiagrams.get(container) ?? []) mounted.destroy()
  _mountedDiagrams.delete(container)
  if (diagramBlocks.length === 0) return

  const { mount } = await import('pele')

  const mounts: Mounted[] = []
  for (const el of diagramBlocks) {
    try {
      mounts.push(mount(el, el.textContent ?? '', {
        // Pele escapes and filters its SVG already; DOMPurify adds a second
        // layer for untrusted paste content
        sanitize: svg => dompurify.sanitize(svg, { RETURN_DOM_FRAGMENT: true }),
      }))
    } catch (e) {
      console.error('Diagram rendering error:', e)
    }
  }
  _mountedDiagrams.set(container, mounts)
}

// ==================== Public API ====================

/**
 * Render markdown content into a container
 */
export async function renderMarkdown(container: HTMLElement, rawContent: string): Promise<void> {
  if (!container) return

  let marked: Marked
  let dompurify: DOMPurify
  try {
    const [markedMod, purify] = await Promise.all([import('marked'), import('dompurify')])
    dompurify = purify.default
    if (!_marked) {
      _marked = createMarked(markedMod.Marked)
    }
    marked = _marked
  } catch (e) {
    container.innerHTML = '<p style="color:red">Error loading rendering libraries.</p>'
    console.error(e)
    return
  }

  // Load KaTeX and register the math tokenizer before parsing, so math is
  // extracted during tokenization. On load failure math degrades to plain text.
  const hasMath = rawContent.includes('$') || rawContent.includes('\\(') || rawContent.includes('\\[')
  if (hasMath && !_katex) {
    try {
      await import('katex/dist/katex.min.css')
      _katex = (await import('katex')).default
    } catch (e) {
      console.error(e)
    }
  }
  if (_marked && _katex && !_mathExtensionRegistered) {
    _mathExtensionRegistered = true
    marked.use({ extensions: [mathExtension] })
  }

  try {
    // Render markdown
    const html = await marked.parse(rawContent)
    container.innerHTML = dompurify.sanitize(html)

    // Highlight code fences with shiki
    const codeBlocks = [...container.querySelectorAll('pre[data-language]')]
    await Promise.all(codeBlocks.map(pre => {
      const language = (pre as HTMLElement).dataset.language || 'plaintext'
      const code = pre.textContent || ''
      return renderStaticHighlightedCode(pre as HTMLElement, code, language, { lineNumbers: true })
    }))

    // Mount Mermaid diagrams with Pele (lazy: only fetched when diagrams exist)
    await mountDiagrams(container, dompurify)

    // Bind copy buttons
    container.querySelectorAll('.copy-snippet-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const codeBlock = btn.nextElementSibling as (HTMLElement & { __rawCode?: string }) | null
        const codeText = codeBlock?.__rawCode ?? codeBlock?.textContent
        if (codeText) {
          navigator.clipboard.writeText(codeText).then(() => {
            showToast(`${icon('code')} Code Copied!`)
          })
        }
      })
    })

  } catch (e) {
    container.innerHTML = '<p style="color:red">Error rendering markdown.</p>'
    console.error('Markdown render error:', e)
  }
}

/**
 * Clear rendered content
 */
export function clearMarkdown(container: HTMLElement | null): void {
  if (container) {
    for (const mounted of _mountedDiagrams.get(container) ?? []) mounted.destroy()
    _mountedDiagrams.delete(container)
    container.innerHTML = ''
  }
}
