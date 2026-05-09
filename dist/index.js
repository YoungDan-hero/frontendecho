// src/recorder.ts
var VERSION = "1.0.0";
var DEFAULT_SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie"];
var HTTPRecorder = class {
  interactions = [];
  cassetteName;
  sanitize;
  constructor(cassetteName, sanitize) {
    this.cassetteName = cassetteName;
    this.sanitize = sanitize;
  }
  record(request, response, duration) {
    const sanitizedRequest = this.sanitizeRequest(request);
    const sanitizedResponse = this.sanitizeResponse(response);
    this.interactions.push({
      request: sanitizedRequest,
      response: sanitizedResponse,
      timestamp: Date.now(),
      duration
    });
  }
  toCassette(base) {
    return {
      id: base?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: base?.name ?? this.cassetteName,
      recordedAt: base?.recordedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      version: VERSION,
      interactions: [...base?.interactions ?? [], ...this.interactions],
      ...base?.metadata ? { metadata: base.metadata } : {}
    };
  }
  get count() {
    return this.interactions.length;
  }
  getLastInteraction() {
    return this.interactions[this.interactions.length - 1] ?? null;
  }
  clear() {
    this.interactions = [];
  }
  sanitizeRequest(request) {
    return {
      ...request,
      headers: this.sanitizeHeaders(request.headers),
      body: request.body ? this.sanitizeText(request.body) : null,
      jsonBody: request.jsonBody ? this.sanitizeValue(request.jsonBody) : null
    };
  }
  sanitizeResponse(response) {
    return {
      ...response,
      headers: this.sanitizeHeaders(response.headers),
      body: this.sanitizeText(response.body),
      jsonBody: response.jsonBody ? this.sanitizeValue(response.jsonBody) : null
    };
  }
  sanitizeHeaders(headers) {
    const result = {};
    const removeFields = this.sanitize?.removeFields ?? [];
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (DEFAULT_SENSITIVE_HEADERS.includes(lowerKey)) continue;
      if (removeFields.includes(lowerKey)) continue;
      result[key] = this.sanitizeText(value);
    }
    return result;
  }
  sanitizeText(text) {
    let result = text;
    if (this.sanitize?.maskApiKeys !== false) {
      result = result.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
      result = result.replace(/key-[a-zA-Z0-9]{20,}/g, "key-***");
      result = result.replace(/token-[a-zA-Z0-9]{20,}/g, "token-***");
      result = result.replace(/bearer\s+[a-zA-Z0-9._-]{20,}/gi, "bearer ***");
    }
    if (this.sanitize?.maskEmails) {
      result = result.replace(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        "***@***.***"
      );
    }
    if (this.sanitize?.customSanitizers) {
      for (const sanitizer of this.sanitize.customSanitizers) {
        result = sanitizer(result);
      }
    }
    return result;
  }
  sanitizeValue(value) {
    if (typeof value === "string") {
      return this.sanitizeText(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeValue(v));
    }
    if (value && typeof value === "object") {
      const result = {};
      const removeFields = this.sanitize?.removeFields ?? [];
      for (const [k, v] of Object.entries(value)) {
        if (removeFields.includes(k)) continue;
        result[k] = this.sanitizeValue(v);
      }
      return result;
    }
    return value;
  }
};

// src/matcher.ts
var HTTPMatcher = class _HTTPMatcher {
  static findBestMatch(request, interactions) {
    for (const interaction of interactions) {
      if (request.method === interaction.request.method && _HTTPMatcher.urlMatches(request.url, interaction.request.url)) {
        return interaction;
      }
    }
    return null;
  }
  static urlMatches(url, pattern) {
    if (pattern instanceof RegExp) {
      return pattern.test(url);
    }
    if (url === pattern) return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$"
      );
      return regex.test(url);
    }
    return url.includes(pattern);
  }
};

// src/replayer.ts
var HTTPReplayer = class {
  interactions = [];
  loadCassette(cassette) {
    this.interactions.push(...cassette.interactions);
  }
  findResponse(request) {
    const match = HTTPMatcher.findBestMatch(request, this.interactions);
    return match?.response ?? null;
  }
  getInteractionCount() {
    return this.interactions.length;
  }
  addInteraction(interaction) {
    this.interactions.push(interaction);
  }
};

// src/utils.ts
function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// src/interceptor.ts
var originalFetch = null;
var originalXHROpen = null;
var originalXHRSend = null;
var originalXHRSetRequestHeader = null;
var installed = false;
var handleFetchRef = null;
var urlsRef = [];
function installInterceptor(urls, handleFetch) {
  if (installed) return;
  urlsRef = urls;
  handleFetchRef = handleFetch;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!shouldIntercept(url, urls)) {
      return originalFetch(input, init);
    }
    const request = await buildHTTPRequestFromFetch(input, init);
    return handleFetch(request, originalFetch);
  };
  interceptXHR();
  installed = true;
}
function uninstallInterceptor() {
  if (!installed) return;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  restoreXHR();
  handleFetchRef = null;
  urlsRef = [];
  installed = false;
}
function interceptXHR() {
  if (typeof XMLHttpRequest === "undefined") return;
  const OriginalXHR = XMLHttpRequest;
  originalXHROpen = OriginalXHR.prototype.open;
  originalXHRSend = OriginalXHR.prototype.send;
  originalXHRSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
  const xhrState = /* @__PURE__ */ new WeakMap();
  OriginalXHR.prototype.open = function(method, url, async = true, username, password) {
    const urlStr = typeof url === "string" ? url : url.toString();
    xhrState.set(this, {
      method: method.toUpperCase(),
      url: urlStr,
      headers: {},
      body: null
    });
    return originalXHROpen.call(this, method, url, async, username, password);
  };
  OriginalXHR.prototype.setRequestHeader = function(name, value) {
    const state = xhrState.get(this);
    if (state) {
      state.headers[name.toLowerCase()] = value;
    }
    return originalXHRSetRequestHeader.call(this, name, value);
  };
  OriginalXHR.prototype.send = function(body) {
    const state = xhrState.get(this);
    if (!state) {
      return originalXHRSend.call(this, body);
    }
    const matched = shouldIntercept(state.url, urlsRef);
    if (!matched) {
      return originalXHRSend.call(this, body);
    }
    if (body !== null && body !== void 0) {
      if (typeof body === "string") {
        state.body = body;
      } else if (body instanceof URLSearchParams) {
        state.body = body.toString();
      }
    }
    const request = {
      url: state.url,
      method: state.method,
      headers: state.headers,
      body: state.body,
      jsonBody: parseJsonSafe(state.body),
      timestamp: Date.now()
    };
    const xhr = this;
    const shimFetch = (_input, _init) => {
      return new Promise((resolve, reject) => {
        const shimXHR = new OriginalXHR();
        originalXHROpen.call(shimXHR, state.method, state.url, true);
        for (const [k, v] of Object.entries(state.headers)) {
          originalXHRSetRequestHeader.call(shimXHR, k, v);
        }
        shimXHR.onload = () => {
          resolve(new Response(shimXHR.responseText, {
            status: shimXHR.status,
            statusText: shimXHR.statusText,
            headers: parseResponseHeaders(shimXHR.getAllResponseHeaders())
          }));
        };
        shimXHR.onerror = () => {
          reject(new Error("Network error"));
        };
        originalXHRSend.call(shimXHR, body);
      });
    };
    handleFetchRef(request, shimFetch).then((response) => {
      response.text().then((text) => {
        Object.defineProperty(xhr, "readyState", { value: 4, writable: true });
        Object.defineProperty(xhr, "status", { value: response.status, writable: true });
        Object.defineProperty(xhr, "statusText", { value: response.statusText, writable: true });
        Object.defineProperty(xhr, "responseText", { value: text, writable: true });
        Object.defineProperty(xhr, "response", { value: text, writable: true });
        let headersStr = "";
        response.headers.forEach((v, k) => {
          headersStr += `${k}: ${v}\r
`;
        });
        Object.defineProperty(xhr, "allResponseHeaders", { value: headersStr, writable: true });
        if (typeof xhr.onreadystatechange === "function") {
          xhr.onreadystatechange.call(xhr, new Event("readystatechange"));
        }
        xhr.dispatchEvent(new Event("readystatechange"));
        if (typeof xhr.onload === "function") {
          xhr.onload(new ProgressEvent("load"));
        }
        xhr.dispatchEvent(new ProgressEvent("load"));
        if (typeof xhr.onloadend === "function") {
          xhr.onloadend(new ProgressEvent("loadend"));
        }
        xhr.dispatchEvent(new ProgressEvent("loadend"));
      });
    }).catch(() => {
      if (typeof xhr.onerror === "function") {
        xhr.onerror(new ProgressEvent("error"));
      }
      xhr.dispatchEvent(new ProgressEvent("error"));
    });
  };
}
function restoreXHR() {
  if (typeof XMLHttpRequest === "undefined") return;
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
    originalXHRSend = null;
  }
  if (originalXHRSetRequestHeader) {
    XMLHttpRequest.prototype.setRequestHeader = originalXHRSetRequestHeader;
    originalXHRSetRequestHeader = null;
  }
}
function shouldIntercept(url, urls) {
  return urls.some((pattern) => HTTPMatcher.urlMatches(url, pattern));
}
async function buildHTTPRequestFromFetch(input, init) {
  let url;
  let method;
  let headers = {};
  let bodyText = null;
  if (input instanceof Request) {
    url = input.url;
    method = input.method;
    const cloned = input.clone();
    bodyText = await cloned.text();
    input.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
  } else {
    url = typeof input === "string" ? input : input.toString();
    method = init?.method?.toUpperCase() ?? "GET";
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    if (init?.body) {
      if (typeof init.body === "string") {
        bodyText = init.body;
      } else {
        bodyText = await readBody(init.body);
      }
    }
  }
  return {
    url,
    method,
    headers,
    body: bodyText,
    jsonBody: parseJsonSafe(bodyText),
    timestamp: Date.now()
  };
}
async function readBody(body) {
  if (typeof body === "string") return body;
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) return null;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(result);
  }
  return null;
}
function parseResponseHeaders(headerStr) {
  const headers = {};
  if (!headerStr) return headers;
  for (const line of headerStr.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

// src/cassette-io.ts
function isBrowser() {
  return typeof globalThis.window !== "undefined" && typeof globalThis.window.document !== "undefined";
}
function isNodeRuntime() {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}
function createDefaultIO(dir) {
  return isNodeRuntime() && !isBrowser() ? createNodeFSIO(dir ?? "./cassettes") : createLocalStorageIO();
}
function createMemoryIO() {
  const store = /* @__PURE__ */ new Map();
  return {
    async load(name) {
      return store.get(name) ?? null;
    },
    async save(cassette) {
      store.set(cassette.name, cassette);
    }
  };
}
function createLocalStorageIO(prefix = "frontendecho-") {
  return {
    async load(name) {
      try {
        const data = localStorage.getItem(prefix + name);
        return data ? JSON.parse(data) : null;
      } catch {
        return null;
      }
    },
    async save(cassette) {
      localStorage.setItem(prefix + cassette.name, JSON.stringify(cassette));
    }
  };
}
function createNodeFSIO(dir) {
  return {
    async load(name) {
      assertNodeFSAvailable();
      const fs = await import("fs/promises");
      const filePath = joinCassettePath(dir, name);
      try {
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data);
      } catch {
        return null;
      }
    },
    async save(cassette) {
      assertNodeFSAvailable();
      const fs = await import("fs/promises");
      await fs.mkdir(dir, { recursive: true });
      const filePath = joinCassettePath(dir, cassette.name);
      await fs.writeFile(filePath, JSON.stringify(cassette, null, 2), "utf-8");
    }
  };
}
function assertNodeFSAvailable() {
  if (!isNodeRuntime() || isBrowser()) {
    throw new Error(
      "[FrontendEcho] createNodeFSIO() only works in Node.js. In frontend apps, use the default adapter or createLocalStorageIO()."
    );
  }
}
function joinCassettePath(dir, name) {
  const normalizedDir = dir.replace(/[\\/]+$/, "");
  return `${normalizedDir}/${name}.json`;
}

// src/engine.ts
var FrontendEchoEngine = class {
  config;
  cassetteIO;
  replayer;
  recorder;
  cassette = null;
  lastRequest = null;
  boundBeforeUnload = null;
  boundProcessExit = null;
  boundSigint = null;
  boundSigterm = null;
  constructor(config) {
    this.config = config;
    this.cassetteIO = config.cassetteIO ?? createDefaultIO(config.cassetteDir);
    this.replayer = new HTTPReplayer();
    this.recorder = new HTTPRecorder(config.cassetteName ?? "default", config.sanitize);
  }
  install() {
    installInterceptor(this.config.urls, this.handleFetch.bind(this));
    this.installAutoSave();
  }
  uninstall() {
    this.uninstallAutoSave();
    uninstallInterceptor();
  }
  async loadCassettes() {
    const cassetteName = this.config.cassetteName ?? "default";
    const cassette = await this.cassetteIO.load(cassetteName);
    if (!cassette) return;
    const isExpired = this.checkExpired(cassette);
    if (isExpired) {
      const onExpired = this.config.onExpired ?? "warn";
      if (onExpired === "error") {
        throw new Error(
          `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Re-record to continue.`
        );
      }
      if (onExpired === "record") {
        console.warn(
          `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Recording a fresh cassette.`
        );
        return;
      }
      console.warn(
        `[FrontendEcho] Cassette "${cassetteName}" has expired (recorded at ${cassette.recordedAt}). Replaying it because onExpired is "warn".`
      );
    }
    this.cassette = cassette;
    this.replayer.loadCassette(cassette);
  }
  async saveCassette() {
    if (this.recorder.count === 0) return;
    const cassette = this.recorder.toCassette(this.cassette);
    await this.cassetteIO.save(cassette);
    this.cassette = cassette;
    this.recorder.clear();
  }
  getStatus() {
    return {
      mode: this.cassette ? "replay" : "record",
      cassetteCount: this.cassette ? 1 : 0,
      interactionCount: this.replayer.getInteractionCount(),
      isExpired: this.cassette ? this.checkExpired(this.cassette) : false,
      recordedAt: this.cassette?.recordedAt
    };
  }
  getLastRequest() {
    return this.lastRequest;
  }
  async handleFetch(request, originalFetch2) {
    this.lastRequest = request;
    const cached = this.replayer.findResponse(request);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers
      });
    }
    return this.doRecord(request, originalFetch2);
  }
  async doRecord(request, originalFetch2) {
    const start = performance.now();
    const response = await originalFetch2(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    const duration = performance.now() - start;
    const bodyText = await response.text();
    const httpResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: normalizeResponseHeaders(response.headers),
      body: bodyText,
      jsonBody: parseJsonSafe(bodyText)
    };
    this.recorder.record(request, httpResponse, duration);
    const interaction = this.recorder.getLastInteraction();
    this.replayer.addInteraction(interaction);
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  installAutoSave() {
    if (!this.boundBeforeUnload && typeof globalThis.addEventListener === "function") {
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
  uninstallAutoSave() {
    const currentProcess = getProcess();
    if (this.boundBeforeUnload && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("beforeunload", this.boundBeforeUnload);
      this.boundBeforeUnload = null;
    }
    if (this.boundProcessExit && currentProcess?.off) {
      currentProcess.off("beforeExit", this.boundProcessExit);
      this.boundProcessExit = null;
    }
    if (this.boundSigint && currentProcess?.off) {
      currentProcess.off("SIGINT", this.boundSigint);
      this.boundSigint = null;
    }
    if (this.boundSigterm && currentProcess?.off) {
      currentProcess.off("SIGTERM", this.boundSigterm);
      this.boundSigterm = null;
    }
  }
  savePendingCassette() {
    if (this.recorder.count > 0) {
      void this.saveCassette();
    }
  }
  checkExpired(cassette) {
    const maxAge = this.config.maxAge;
    if (maxAge == null) return false;
    const recordedAt = new Date(cassette.recordedAt).getTime();
    if (Number.isNaN(recordedAt)) {
      throw new Error(
        `[FrontendEcho] Cassette "${cassette.name}" has an invalid recordedAt value: ${cassette.recordedAt}.`
      );
    }
    const now = Date.now();
    const age = now - recordedAt;
    const maxAgeMs = parseMaxAge(maxAge);
    return age > maxAgeMs;
  }
};
function normalizeResponseHeaders(headers) {
  const result = {};
  headers.forEach((v, k) => {
    result[k.toLowerCase()] = v;
  });
  return result;
}
function getProcess() {
  const maybeProcess = globalThis.process;
  if (maybeProcess && typeof maybeProcess.on === "function" && typeof maybeProcess.exit === "function") {
    return maybeProcess;
  }
  return null;
}
function parseMaxAge(maxAge) {
  if (typeof maxAge === "number") {
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new Error(
        `[FrontendEcho] maxAge must be a positive number of milliseconds. Received: ${maxAge}.`
      );
    }
    return maxAge;
  }
  const match = maxAge.match(/^(\d+)(d|h|m|s)$/);
  if (!match) {
    throw new Error(
      `[FrontendEcho] Invalid maxAge "${maxAge}". Use a positive number of milliseconds or a string like "7d", "24h", "30m", or "60s".`
    );
  }
  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new Error(
      `[FrontendEcho] maxAge must be greater than 0. Received: "${maxAge}".`
    );
  }
  switch (match[2]) {
    case "d":
      return value * 24 * 60 * 60 * 1e3;
    case "h":
      return value * 60 * 60 * 1e3;
    case "m":
      return value * 60 * 1e3;
    case "s":
      return value * 1e3;
    default:
      throw new Error(
        `[FrontendEcho] Invalid maxAge unit in "${maxAge}".`
      );
  }
}
function httpMock(config) {
  return new FrontendEchoEngine(config);
}
export {
  FrontendEchoEngine,
  createDefaultIO,
  createLocalStorageIO,
  createMemoryIO,
  createNodeFSIO,
  httpMock,
  isBrowser
};
//# sourceMappingURL=index.js.map