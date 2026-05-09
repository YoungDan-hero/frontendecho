import type {
  HTTPRequest,
  HTTPResponse,
  HTTPCassette,
  HTTPInteraction,
  SanitizeConfig,
} from "./types";

const VERSION = "1.0.0";

const DEFAULT_SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie"];

export class HTTPRecorder {
  private interactions: HTTPInteraction[] = [];
  private cassetteName: string;
  private sanitize?: SanitizeConfig;

  constructor(cassetteName: string, sanitize?: SanitizeConfig) {
    this.cassetteName = cassetteName;
    this.sanitize = sanitize;
  }

  record(request: HTTPRequest, response: HTTPResponse, duration: number): void {
    const sanitizedRequest = this.sanitizeRequest(request);
    const sanitizedResponse = this.sanitizeResponse(response);

    this.interactions.push({
      request: sanitizedRequest,
      response: sanitizedResponse,
      timestamp: Date.now(),
      duration,
    });
  }

  toCassette(base?: HTTPCassette | null): HTTPCassette {
    return {
      id: base?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: base?.name ?? this.cassetteName,
      recordedAt: base?.recordedAt ?? new Date().toISOString(),
      version: VERSION,
      interactions: [...(base?.interactions ?? []), ...this.interactions],
      ...(base?.metadata ? { metadata: base.metadata } : {}),
    };
  }

  get count(): number {
    return this.interactions.length;
  }

  getLastInteraction(): HTTPInteraction | null {
    return this.interactions[this.interactions.length - 1] ?? null;
  }

  clear(): void {
    this.interactions = [];
  }

  private sanitizeRequest(request: HTTPRequest): HTTPRequest {
    return {
      ...request,
      headers: this.sanitizeHeaders(request.headers),
      body: request.body ? this.sanitizeText(request.body) : null,
      jsonBody: request.jsonBody ? this.sanitizeValue(request.jsonBody) : null,
    };
  }

  private sanitizeResponse(response: HTTPResponse): HTTPResponse {
    return {
      ...response,
      headers: this.sanitizeHeaders(response.headers),
      body: this.sanitizeText(response.body),
      jsonBody: response.jsonBody
        ? this.sanitizeValue(response.jsonBody)
        : null,
    };
  }

  private sanitizeHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    const removeFields = this.sanitize?.removeFields ?? [];

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();

      // Remove sensitive headers by default
      if (DEFAULT_SENSITIVE_HEADERS.includes(lowerKey)) continue;
      // Remove user-specified fields
      if (removeFields.includes(lowerKey)) continue;

      result[key] = this.sanitizeText(value);
    }

    return result;
  }

  private sanitizeText(text: string): string {
    let result = text;

    if (this.sanitize?.maskApiKeys !== false) {
      // Mask common API key patterns
      result = result.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
      result = result.replace(/key-[a-zA-Z0-9]{20,}/g, "key-***");
      result = result.replace(/token-[a-zA-Z0-9]{20,}/g, "token-***");
      result = result.replace(/bearer\s+[a-zA-Z0-9._-]{20,}/gi, "bearer ***");
    }

    if (this.sanitize?.maskEmails) {
      result = result.replace(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        "***@***.***",
      );
    }

    if (this.sanitize?.customSanitizers) {
      for (const sanitizer of this.sanitize.customSanitizers) {
        result = sanitizer(result);
      }
    }

    return result;
  }

  private sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.sanitizeText(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeValue(v));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      const removeFields = this.sanitize?.removeFields ?? [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (removeFields.includes(k)) continue;
        result[k] = this.sanitizeValue(v);
      }
      return result;
    }
    return value;
  }
}
