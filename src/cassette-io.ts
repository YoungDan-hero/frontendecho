import type { CassetteIOAdapter, HTTPCassette } from './types'

/**
 * Detect if running in a browser environment.
 */
export function isBrowser(): boolean {
  return typeof globalThis.window !== 'undefined'
    && typeof globalThis.window.document !== 'undefined'
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined'
    && typeof process.versions?.node === 'string'
}

/**
 * Create the default storage adapter based on the current environment.
 * - Browser: localStorage
 * - Node.js: filesystem
 */
export function createDefaultIO(dir?: string): CassetteIOAdapter {
  return isNodeRuntime() && !isBrowser() ? createNodeFSIO(dir ?? './cassettes') : createLocalStorageIO()
}

/**
 * In-memory storage adapter. Useful for testing.
 */
export function createMemoryIO(): CassetteIOAdapter {
  const store = new Map<string, HTTPCassette>()

  return {
    async load(name: string): Promise<HTTPCassette | null> {
      return store.get(name) ?? null
    },
    async save(cassette: HTTPCassette): Promise<void> {
      store.set(cassette.name, cassette)
    },
  }
}

/**
 * localStorage storage adapter. Works in browser test environments.
 */
export function createLocalStorageIO(prefix = 'frontendecho-'): CassetteIOAdapter {
  return {
    async load(name: string): Promise<HTTPCassette | null> {
      try {
        const data = localStorage.getItem(prefix + name)
        return data ? JSON.parse(data) : null
      } catch {
        return null
      }
    },
    async save(cassette: HTTPCassette): Promise<void> {
      localStorage.setItem(prefix + cassette.name, JSON.stringify(cassette))
    },
  }
}

/**
 * Node.js filesystem storage adapter.
 * Uses dynamic import to avoid bundling Node.js code for browser builds.
 */
export function createNodeFSIO(dir: string): CassetteIOAdapter {
  return {
    async load(name: string): Promise<HTTPCassette | null> {
      assertNodeFSAvailable()
      const fs = await import('node:fs/promises')
      const filePath = joinCassettePath(dir, name)
      try {
        const data = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(data)
      } catch {
        return null
      }
    },
    async save(cassette: HTTPCassette): Promise<void> {
      assertNodeFSAvailable()
      const fs = await import('node:fs/promises')
      await fs.mkdir(dir, { recursive: true })
      const filePath = joinCassettePath(dir, cassette.name)
      await fs.writeFile(filePath, JSON.stringify(cassette, null, 2), 'utf-8')
    },
  }
}

function assertNodeFSAvailable(): void {
  if (!isNodeRuntime() || isBrowser()) {
    throw new Error(
      '[FrontendEcho] createNodeFSIO() only works in Node.js. In frontend apps, use the default adapter or createLocalStorageIO().',
    )
  }
}

function joinCassettePath(dir: string, name: string): string {
  const normalizedDir = dir.replace(/[\\/]+$/, '')
  return `${normalizedDir}/${name}.json`
}
