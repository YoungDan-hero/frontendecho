interface HTTPRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    jsonBody: unknown | null;
    timestamp: number;
}
interface HTTPResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    jsonBody: unknown | null;
}
interface HTTPCassette {
    id: string;
    name: string;
    recordedAt: string;
    version: string;
    interactions: HTTPInteraction[];
    metadata?: Record<string, unknown>;
}
interface HTTPInteraction {
    request: HTTPRequest;
    response: HTTPResponse;
    timestamp: number;
    duration: number;
}
interface FrontendEchoConfig {
    cassetteDir?: string;
    cassetteName?: string;
    maxAge?: string | number;
    onExpired?: 'warn' | 'error' | 'record';
    urls: Array<string | RegExp>;
    cassetteIO?: CassetteIOAdapter;
    sanitize?: SanitizeConfig;
}
interface CassetteIOAdapter {
    load(name: string): Promise<HTTPCassette | null>;
    save(cassette: HTTPCassette): Promise<void>;
}
interface SanitizeConfig {
    maskApiKeys?: boolean;
    maskEmails?: boolean;
    customSanitizers?: Array<(text: string) => string>;
    removeFields?: string[];
}
interface EngineStatus {
    mode: 'record' | 'replay';
    cassetteCount: number;
    interactionCount: number;
    isExpired: boolean;
    recordedAt?: string;
}

declare class FrontendEchoEngine {
    private config;
    private cassetteIO;
    private replayer;
    private recorder;
    private cassette;
    private lastRequest;
    private boundBeforeUnload;
    private boundProcessExit;
    private boundSigint;
    private boundSigterm;
    constructor(config: FrontendEchoConfig);
    install(): void;
    uninstall(): void;
    loadCassettes(): Promise<void>;
    saveCassette(): Promise<void>;
    getStatus(): EngineStatus;
    getLastRequest(): HTTPRequest | null;
    private handleFetch;
    private doRecord;
    private installAutoSave;
    private uninstallAutoSave;
    private savePendingCassette;
    private checkExpired;
}
declare function httpMock(config: FrontendEchoConfig): FrontendEchoEngine;

/**
 * Detect if running in a browser environment.
 */
declare function isBrowser(): boolean;
/**
 * Create the default storage adapter based on the current environment.
 * - Browser: localStorage
 * - Node.js: filesystem
 */
declare function createDefaultIO(dir?: string): CassetteIOAdapter;
/**
 * In-memory storage adapter. Useful for testing.
 */
declare function createMemoryIO(): CassetteIOAdapter;
/**
 * localStorage storage adapter. Works in browser test environments.
 */
declare function createLocalStorageIO(prefix?: string): CassetteIOAdapter;
/**
 * Node.js filesystem storage adapter.
 * Uses dynamic import to avoid bundling Node.js code for browser builds.
 */
declare function createNodeFSIO(dir: string): CassetteIOAdapter;

export { type CassetteIOAdapter, type EngineStatus, type FrontendEchoConfig, FrontendEchoEngine, type HTTPCassette, type HTTPInteraction, type HTTPRequest, type HTTPResponse, type SanitizeConfig, createDefaultIO, createLocalStorageIO, createMemoryIO, createNodeFSIO, httpMock, isBrowser };
