/**
 * Global type declarations for ShareBin frontend
 * External libraries loaded via CDN at runtime
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// html2canvas
declare const html2canvas: (
  element: HTMLElement,
  options?: Record<string, any>,
) => Promise<HTMLCanvasElement>

// App configuration
interface AppConfig {
  maxContentSize: number
  expirationDays: number
  cdnBase: string
  [key: string]: any
}

// CodeMirror editor handle
interface EditorHandle {
  view: import('@codemirror/view').EditorView
  getValue: () => string
  setValue: (value: string) => void
  focus: () => void
  setCursorToEnd: () => void
  setLanguage: (language: string) => Promise<void>
  destroy: () => void
}

// API response types
interface PasteResponse {
  id: string
  content: string
  language: string
  type: 'code' | 'url'
  url?: string
  expiresIn?: number
  expiration: string
}

interface CreatePasteResponse {
  id: string
}

interface ApiErrorResponse {
  error?: string
  code?: string
}

declare module '*.css'

// Allow dynamic URL imports
declare module 'https://*' {
  const mod: any
  export default mod
}

declare module 'http://*' {
  const mod: any
  export default mod
}
