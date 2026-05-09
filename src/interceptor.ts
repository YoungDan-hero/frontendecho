import type { HTTPRequest } from './types'
import { HTTPMatcher } from './matcher'
import { parseJsonSafe } from './utils'

type HandleFetch = (request: HTTPRequest, originalFetch: typeof fetch) => Promise<Response>

let originalFetch: typeof fetch | null = null
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null
let originalXHRSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null
let installed = false
let handleFetchRef: HandleFetch | null = null
let urlsRef: Array<string | RegExp> = []

export function installInterceptor(
  urls: Array<string | RegExp>,
  handleFetch: HandleFetch,
): void {
  if (installed) return

  urlsRef = urls
  handleFetchRef = handleFetch

  // Intercept fetch
  originalFetch = globalThis.fetch
  globalThis.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (!shouldIntercept(url, urls)) {
      return originalFetch!(input, init)
    }

    const request = await buildHTTPRequestFromFetch(input, init)
    return handleFetch(request, originalFetch!)
  }

  // Intercept XMLHttpRequest (used by Axios)
  interceptXHR()

  installed = true
}

export function uninstallInterceptor(): void {
  if (!installed) return

  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = null
  }

  restoreXHR()

  handleFetchRef = null
  urlsRef = []
  installed = false
}

// ─── XHR Interception ──────────────────────────────────────────

function interceptXHR(): void {
  if (typeof XMLHttpRequest === 'undefined') return

  const OriginalXHR = XMLHttpRequest

  originalXHROpen = OriginalXHR.prototype.open
  originalXHRSend = OriginalXHR.prototype.send
  originalXHRSetRequestHeader = OriginalXHR.prototype.setRequestHeader

  // Store per-instance state
  const xhrState = new WeakMap<XMLHttpRequest, {
    method: string
    url: string
    headers: Record<string, string>
    body: string | null
  }>()

  OriginalXHR.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    const urlStr = typeof url === 'string' ? url : url.toString()
    xhrState.set(this, {
      method: method.toUpperCase(),
      url: urlStr,
      headers: {},
      body: null,
    })
    return originalXHROpen!.call(this, method, url, async, username, password)
  }

  OriginalXHR.prototype.setRequestHeader = function (name: string, value: string) {
    const state = xhrState.get(this)
    if (state) {
      state.headers[name.toLowerCase()] = value
    }
    return originalXHRSetRequestHeader!.call(this, name, value)
  }

  OriginalXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const state = xhrState.get(this)
    if (!state) {
      return originalXHRSend!.call(this, body)
    }
    const matched = shouldIntercept(state.url, urlsRef)
    if (!matched) {
      return originalXHRSend!.call(this, body)
    }

    // Read body
    if (body !== null && body !== undefined) {
      if (typeof body === 'string') {
        state.body = body
      } else if (body instanceof URLSearchParams) {
        state.body = body.toString()
      }
    }

    const request: HTTPRequest = {
      url: state.url,
      method: state.method,
      headers: state.headers,
      body: state.body,
      jsonBody: parseJsonSafe(state.body),
      timestamp: Date.now(),
    }

    const xhr = this

    // Call handleFetch with a shim originalFetch that uses original XHR methods
    // (avoids re-interception by our own patched methods)
    const shimFetch: typeof fetch = (_input, _init) => {
      return new Promise((resolve, reject) => {
        const shimXHR = new OriginalXHR()
        originalXHROpen!.call(shimXHR, state.method, state.url, true)
        for (const [k, v] of Object.entries(state.headers)) {
          originalXHRSetRequestHeader!.call(shimXHR, k, v)
        }
        shimXHR.onload = () => {
          resolve(new Response(shimXHR.responseText, {
            status: shimXHR.status,
            statusText: shimXHR.statusText,
            headers: parseResponseHeaders(shimXHR.getAllResponseHeaders()),
          }))
        }
        shimXHR.onerror = () => {
          reject(new Error('Network error'))
        }
        originalXHRSend!.call(shimXHR, body)
      })
    }

    handleFetchRef!(request, shimFetch).then((response) => {
      // Simulate XHR response from the Response object
      response.text().then((text) => {
        // Define response properties on the XHR instance
        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true })
        Object.defineProperty(xhr, 'status', { value: response.status, writable: true })
        Object.defineProperty(xhr, 'statusText', { value: response.statusText, writable: true })
        Object.defineProperty(xhr, 'responseText', { value: text, writable: true })
        Object.defineProperty(xhr, 'response', { value: text, writable: true })

        // Build response headers string
        let headersStr = ''
        response.headers.forEach((v, k) => {
          headersStr += `${k}: ${v}\r\n`
        })
        Object.defineProperty(xhr, 'allResponseHeaders', { value: headersStr, writable: true })

        // Trigger callbacks
        if (typeof xhr.onreadystatechange === 'function') {
          xhr.onreadystatechange.call(xhr, new Event('readystatechange'))
        }
        xhr.dispatchEvent(new Event('readystatechange'))
        if (typeof xhr.onload === 'function') {
          xhr.onload(new ProgressEvent('load'))
        }
        xhr.dispatchEvent(new ProgressEvent('load'))
        if (typeof xhr.onloadend === 'function') {
          xhr.onloadend(new ProgressEvent('loadend'))
        }
        xhr.dispatchEvent(new ProgressEvent('loadend'))
      })
    }).catch(() => {
      if (typeof xhr.onerror === 'function') {
        xhr.onerror(new ProgressEvent('error'))
      }
      xhr.dispatchEvent(new ProgressEvent('error'))
    })
  }
}

function restoreXHR(): void {
  if (typeof XMLHttpRequest === 'undefined') return
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen
    originalXHROpen = null
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend
    originalXHRSend = null
  }
  if (originalXHRSetRequestHeader) {
    XMLHttpRequest.prototype.setRequestHeader = originalXHRSetRequestHeader
    originalXHRSetRequestHeader = null
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function shouldIntercept(url: string, urls: Array<string | RegExp>): boolean {
  return urls.some((pattern) => HTTPMatcher.urlMatches(url, pattern))
}

async function buildHTTPRequestFromFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<HTTPRequest> {
  let url: string
  let method: string
  let headers: Record<string, string> = {}
  let bodyText: string | null = null

  if (input instanceof Request) {
    url = input.url
    method = input.method
    const cloned = input.clone()
    bodyText = await cloned.text()
    input.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
  } else {
    url = typeof input === 'string' ? input : input.toString()
    method = init?.method?.toUpperCase() ?? 'GET'
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k.toLowerCase()] = v
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = v
        }
      }
    }
    if (init?.body) {
      if (typeof init.body === 'string') {
        bodyText = init.body
      } else {
        bodyText = await readBody(init.body)
      }
    }
  }

  return {
    url,
    method,
    headers,
    body: bodyText,
    jsonBody: parseJsonSafe(bodyText),
    timestamp: Date.now(),
  }
}

async function readBody(body: BodyInit): Promise<string | null> {
  if (typeof body === 'string') return body
  if (body instanceof Blob) return body.text()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof FormData) return null
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(result)
  }
  return null
}

function parseResponseHeaders(headerStr: string): HeadersInit {
  const headers: Record<string, string> = {}
  if (!headerStr) return headers
  for (const line of headerStr.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim()
    }
  }
  return headers
}
