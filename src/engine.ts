import type {
  HTTPRequest,
  HTTPResponse,
  HTTPCassette,
  FrontendEchoConfig,
  CassetteIOAdapter,
  EngineStatus,
} from "./types";
import { HTTPRecorder } from "./recorder";
import { HTTPReplayer } from "./replayer";
import { installInterceptor, uninstallInterceptor } from "./interceptor";
import { createDefaultIO } from "./cassette-io";
import { parseJsonSafe } from "./utils";

type ProcessEventName = "beforeExit" | "SIGINT" | "SIGTERM";

interface ProcessLike {
  on(event: ProcessEventName, listener: () => void): void;
  off?(event: ProcessEventName, listener: () => void): void;
  exit(code?: number): never;
}

export class FrontendEchoEngine {
  private config: FrontendEchoConfig;
  private cassetteIO: CassetteIOAdapter;
  private replayer: HTTPReplayer;
  private recorder: HTTPRecorder;
  private cassette: HTTPCassette | null = null;
  private lastRequest: HTTPRequest | null = null;
  private boundBeforeUnload: (() => void) | null = null;
  private boundProcessExit: (() => void) | null = null;
  private boundSigint: (() => void) | null = null;
  private boundSigterm: (() => void) | null = null;

  constructor(config: FrontendEchoConfig) {
    this.config = config;
    this.cassetteIO = config.cassetteIO ?? createDefaultIO(config.cassetteDir);
    this.replayer = new HTTPReplayer();
    this.recorder = new HTTPRecorder(config.cassetteName ?? "default", config.sanitize);
  }

  install(): void {
    installInterceptor(this.config.urls, this.handleFetch.bind(this));
    this.installAutoSave();
  }

  uninstall(): void {
    this.uninstallAutoSave();
    uninstallInterceptor();
  }

  async loadCassettes(): Promise<void> {
    const cassetteName = this.config.cassetteName ?? "default";
    const cassette = await this.cassetteIO.load(cassetteName);

    if (!cassette) return;

    const isExpired = this.checkExpired(cassette);
    if (isExpired) {
      const onExpired = this.config.onExpired ?? "warn";

      if (onExpired === "error") {
        throw new Error(
          `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Re-record to continue.`,
        );
      }

      if (onExpired === "record") {
        console.warn(
          `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Recording a fresh cassette.`,
        );
        return;
      }

      console.warn(
        `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Replaying it because onExpired is "warn".`,
      );
    }

    this.cassette = cassette;
    this.replayer.loadCassette(cassette);
  }

  async saveCassette(): Promise<void> {
    if (this.recorder.count === 0) return;

    const cassette = this.recorder.toCassette(this.cassette);
    await this.cassetteIO.save(cassette);
    this.cassette = cassette;
    this.recorder.clear();
  }

  getStatus(): EngineStatus {
    return {
      mode: this.cassette ? "replay" : "record",
      cassetteCount: this.cassette ? 1 : 0,
      interactionCount: this.replayer.getInteractionCount(),
      isExpired: this.cassette ? this.checkExpired(this.cassette) : false,
      recordedAt: this.cassette?.recordedAt,
    };
  }

  getLastRequest(): HTTPRequest | null {
    return this.lastRequest;
  }

  private async handleFetch(
    request: HTTPRequest,
    originalFetch: typeof fetch,
  ): Promise<Response> {
    this.lastRequest = request;

    const cached = this.replayer.findResponse(request);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers,
      });
    }

    return this.doRecord(request, originalFetch);
  }

  private async doRecord(
    request: HTTPRequest,
    originalFetch: typeof fetch,
  ): Promise<Response> {
    const start = performance.now();
    const response = await originalFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const duration = performance.now() - start;

    const bodyText = await response.text();

    const httpResponse: HTTPResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: normalizeResponseHeaders(response.headers),
      body: bodyText,
      jsonBody: parseJsonSafe(bodyText),
    };

    // Record through recorder (handles sanitization)
    this.recorder.record(request, httpResponse, duration);

    // Add to replayer for same-session caching
    const interaction = this.recorder.getLastInteraction()!;
    this.replayer.addInteraction(interaction);

    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private installAutoSave(): void {
    if (
      !this.boundBeforeUnload &&
      typeof globalThis.addEventListener === "function"
    ) {
      this.boundBeforeUnload = () => {
        this.savePendingCassette();
      };
      globalThis.addEventListener("beforeunload", this.boundBeforeUnload);
    }

    const currentProcess = getProcess();
    if (!this.boundProcessExit && currentProcess) {
      this.boundProcessExit = () => {
        this.savePendingCassette();
      };
      this.boundSigint = () => {
        this.savePendingCassette();
        currentProcess.exit(0);
      };
      this.boundSigterm = () => {
        this.savePendingCassette();
        currentProcess.exit(0);
      };
      currentProcess.on("beforeExit", this.boundProcessExit);
      currentProcess.on("SIGINT", this.boundSigint);
      currentProcess.on("SIGTERM", this.boundSigterm);
    }
  }

  private uninstallAutoSave(): void {
    const currentProcess = getProcess();

    if (
      this.boundBeforeUnload &&
      typeof globalThis.removeEventListener === "function"
    ) {
      globalThis.removeEventListener("beforeunload", this.boundBeforeUnload);
      this.boundBeforeUnload = null;
    }
    if (
      this.boundProcessExit &&
      currentProcess?.off
    ) {
      currentProcess.off("beforeExit", this.boundProcessExit);
      this.boundProcessExit = null;
    }
    if (
      this.boundSigint &&
      currentProcess?.off
    ) {
      currentProcess.off("SIGINT", this.boundSigint);
      this.boundSigint = null;
    }
    if (
      this.boundSigterm &&
      currentProcess?.off
    ) {
      currentProcess.off("SIGTERM", this.boundSigterm);
      this.boundSigterm = null;
    }
  }

  private savePendingCassette(): void {
    if (this.recorder.count > 0) {
      void this.saveCassette();
    }
  }

  private checkExpired(cassette: HTTPCassette): boolean {
    const maxAge = this.config.maxAge;
    if (maxAge == null) return false;

    const recordedAt = new Date(cassette.recordedAt).getTime();
    if (Number.isNaN(recordedAt)) {
      throw new Error(
        `[FrontendEcho] Cassette "${cassette.name}" has an invalid recordedAt value: ${cassette.recordedAt}.`,
      );
    }

    const now = Date.now();
    const age = now - recordedAt;
    const maxAgeMs = parseMaxAge(maxAge);

    return age > maxAgeMs;
  }
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((v, k) => {
    result[k.toLowerCase()] = v;
  });
  return result;
}

function getProcess(): ProcessLike | null {
  const maybeProcess = (globalThis as typeof globalThis & {
    process?: Partial<ProcessLike>;
  }).process;

  if (
    maybeProcess &&
    typeof maybeProcess.on === "function" &&
    typeof maybeProcess.exit === "function"
  ) {
    return maybeProcess as ProcessLike;
  }

  return null;
}

function parseMaxAge(maxAge: string | number): number {
  if (typeof maxAge === "number") {
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new Error(
        `[FrontendEcho] maxAge must be a positive number of milliseconds. Received: ${maxAge}.`,
      );
    }
    return maxAge;
  }

  const match = maxAge.match(/^(\d+)(d|h|m|s)$/);
  if (!match) {
    throw new Error(
      `[FrontendEcho] Invalid maxAge "${maxAge}". Use a positive number of milliseconds or a string like "7d", "24h", "30m", or "60s".`,
    );
  }

  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new Error(
      `[FrontendEcho] maxAge must be greater than 0. Received: "${maxAge}".`,
    );
  }

  switch (match[2]) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "s":
      return value * 1000;
    default:
      throw new Error(
        `[FrontendEcho] Invalid maxAge unit in "${maxAge}".`,
      );
  }
}

export function httpMock(config: FrontendEchoConfig): FrontendEchoEngine {
  return new FrontendEchoEngine(config);
}
