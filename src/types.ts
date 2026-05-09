// ─── HTTP Request / Response ──────────────────────────────────────

export interface HTTPRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  jsonBody: unknown | null
  timestamp: number
}

export interface HTTPResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  jsonBody: unknown | null
}

// ─── Cassette (Recording) ────────────────────────────────────────

export interface HTTPCassette {
  id: string
  name: string
  recordedAt: string
  version: string
  interactions: HTTPInteraction[]
  metadata?: Record<string, unknown>
}

export interface HTTPInteraction {
  request: HTTPRequest
  response: HTTPResponse
  timestamp: number
  duration: number
}

// ─── Engine Config ───────────────────────────────────────────────

export interface FrontendEchoConfig {
  cassetteDir?: string
  cassetteName?: string
  maxAge?: string | number
  onExpired?: 'warn' | 'error' | 'record'
  urls: Array<string | RegExp>
  cassetteIO?: CassetteIOAdapter
  sanitize?: SanitizeConfig
}

export interface CassetteIOAdapter {
  load(name: string): Promise<HTTPCassette | null>
  save(cassette: HTTPCassette): Promise<void>
}

export interface SanitizeConfig {
  maskApiKeys?: boolean
  maskEmails?: boolean
  customSanitizers?: Array<(text: string) => string>
  removeFields?: string[]
}

// ─── Engine Status ───────────────────────────────────────────────

export interface EngineStatus {
  mode: 'record' | 'replay'
  cassetteCount: number
  interactionCount: number
  isExpired: boolean
  recordedAt?: string
}
