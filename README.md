# FrontendEcho

前端 AI 接口开发用的 HTTP 请求录制/回放工具。

**第一次请求真实后端，之后在有效期内本地回放，避免重复触发昂贵、慢速的 AI 调用。**

## 为什么需要它

开发 AI 产品时，前端经常需要反复调试同一个交互：

- 聊天 UI 的 loading、错误态、空状态、长文本展示
- AI 生成结果的排版、复制、重试、编辑
- 多轮对话、历史记录、引用来源、工具调用结果展示

这些调试通常都会打到后端，而后端可能继续调用大模型。结果就是：

- **贵**：重复请求会持续消耗 token 或模型调用额度
- **慢**：AI 响应通常需要几秒到几十秒
- **不稳定**：同一个输入可能每次返回不同内容，影响 UI 调试

FrontendEcho 的做法很简单：

```txt
首次开发：
  前端 -> 业务后端 -> AI 服务 -> 返回真实响应 -> FrontendEcho 录制

之后开发：
  前端 -> FrontendEcho 本地回放 -> 不再请求后端 -> 不再触发 AI 调用
```

它不是模型网关，也不分析后端 prompt、model、temperature 或 token usage。它只负责前端可见的 HTTP 请求与响应。

## 适合场景

- 反复调试 `/api/chat`、`/api/generate`、`/api/summary` 等 AI 接口 UI。
- 希望复用真实响应，避免每次调试都请求后端或大模型。
- 后端服务临时不可用，但前端仍要基于已录制响应继续开发。
- 团队希望共享一组真实接口响应，作为开发 fixture。

不适合：

- 生产环境缓存。
- 后端 AI 网关。
- 精确 token 成本统计。
- 复杂 API mock server 替代品。

## 安装

```bash
npm install -D frontendecho
```

## 快速开始

只建议在开发环境启用：

```ts
import { httpMock } from "frontendecho";

if (import.meta.env.DEV) {
  const engine = httpMock({
    urls: ["/api/chat"],
    maxAge: "1d",
    onExpired: "record",
  });

  await engine.loadCassettes();
  engine.install();
}
```

业务代码不需要修改：

```ts
async function sendMessage(message: string) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  return res.json();
}
```

第一次运行时，如果没有找到 cassette，FrontendEcho 会进入录制模式：请求继续发送到真实后端，并记录响应。后续运行命中已录制请求时，会直接返回本地响应。

如果 cassette 已过期，推荐使用 `onExpired: "record"`：FrontendEcho 会跳过旧 cassette，重新请求真实后端并保存新的录制结果。

## 工作流程

```txt
首次请求:
  前端 -> 业务后端 -> AI 服务 -> 返回真实响应 -> FrontendEcho 录制

后续命中:
  前端 -> FrontendEcho 本地回放 -> 不请求后端 -> 不触发 AI 调用

过期重录:
  FrontendEcho 检测 cassette 过期 -> 跳过旧响应 -> 请求真实后端 -> 保存新 cassette
```

重新录制时，删除旧 cassette 后重新启动即可：

```bash
rm -rf ./cassettes
npm run dev
```

## 配置

```ts
import {
  createLocalStorageIO,
  createMemoryIO,
  createNodeFSIO,
  httpMock,
} from "frontendecho";

const engine = httpMock({
  cassetteDir: "./cassettes",
  cassetteName: "default",
  urls: ["/api/chat", "/api/ai/*", /^\/api\/v2\/chat$/],
  maxAge: "7d",
  onExpired: "warn",

  // 浏览器项目默认使用 localStorage；也可以显式传入自定义适配器。
  cassetteIO: createLocalStorageIO("frontendecho-"),

  sanitize: {
    maskApiKeys: true,
    maskEmails: false,
    removeFields: ["password", "accessToken"],
    customSanitizers: [(text) => text.replace(/my-secret/g, "***")],
  },
});

await engine.loadCassettes();
engine.install();
```

### `urls`

指定需要拦截的接口。不匹配的请求会原样走网络。

```ts
urls: ["/api/chat", "/api/ai/*", /^\/api\/v2\/chat$/];
```

字符串匹配支持三种形式：

- 普通字符串：使用 `url.includes(pattern)`。
- 带 `*` 的字符串：按路径片段通配匹配。
- `RegExp`：直接执行正则匹配。

回放匹配当前基于 `method + url`，不会比较请求体。

### `maxAge`

控制 cassette 有效期：

- `"7d"`：7 天。
- `"24h"`：24 小时。
- `"30m"`：30 分钟。
- `"60s"`：60 秒。
- `86400000`：毫秒数。

`maxAge` 必须大于 `0`。不传 `maxAge` 表示不启用过期检测；非法字符串会直接抛错，避免静默误判。

### `onExpired`

控制 cassette 过期后的行为：

```ts
onExpired: "warn"; // 默认。控制台警告，但继续回放旧 cassette
onExpired: "error"; // 抛错，阻止继续使用过期 cassette
onExpired: "record"; // 跳过旧 cassette，进入录制模式并覆盖保存新 cassette
```

如果你希望到期后自动重新录制，使用 `onExpired: "record"`。

### `sanitize`

录制时会默认移除敏感请求头：

- `Authorization`
- `Cookie`
- `Set-Cookie`

默认也会脱敏常见密钥格式：

- `sk-*`
- `key-*`
- `token-*`
- `bearer *`

你可以继续追加字段移除和自定义脱敏：

```ts
sanitize: {
  maskApiKeys: true,
  maskEmails: true,
  removeFields: ["password", "accessToken"],
  customSanitizers: [
    (text) => text.replace(/internal-user-\d+/g, "internal-user-***"),
  ],
}
```

### `cassetteIO`

控制 cassette 存储位置：

```ts
// Node.js 文件系统
cassetteIO: createNodeFSIO("./cassettes");

// 浏览器 localStorage
cassetteIO: createLocalStorageIO("frontendecho-");

// 内存存储，适合测试
cassetteIO: createMemoryIO();
```

默认适配器会根据运行环境选择：

- 浏览器：`localStorage`。
- Node.js：文件系统。

## API

### `httpMock(config)`

创建 FrontendEcho 引擎。

```ts
const engine = httpMock({
  cassetteDir: "./cassettes",
  urls: ["/api/chat"],
});
```

### `engine.loadCassettes()`

加载 cassette，并自动判断模式：

- 找到 cassette：进入 `replay`。
- 找不到 cassette：进入 `record`。
- 找到但已过期：按 `onExpired` 处理。`record` 会重新录制；`warn` 会继续回放；`error` 会抛错。

### `engine.install()`

安装拦截器，并注册自动保存。当前会拦截匹配 URL 的 `fetch` 和 `XMLHttpRequest` 请求。

### `engine.uninstall()`

卸载拦截器，并移除自动保存监听。

### `engine.saveCassette()`

手动保存当前录制数据。通常不必调用，但适合在关键流程结束后主动落盘。

### `engine.getStatus()`

获取当前状态：

```ts
const status = engine.getStatus();

// {
//   mode: "replay",
//   cassetteCount: 1,
//   interactionCount: 5,
//   isExpired: false,
//   recordedAt: "2025-05-08T10:30:00.000Z"
// }
```

### `engine.getLastRequest()`

获取最近一次被拦截的请求，方便调试匹配问题。

## Cassette 格式

录制结果是普通 JSON，可以提交到 Git 共享：

```json
{
  "id": "1715123456789-abc123",
  "name": "default",
  "recordedAt": "2025-05-08T10:30:00.000Z",
  "version": "1.0.0",
  "interactions": [
    {
      "request": {
        "url": "/api/chat",
        "method": "POST",
        "headers": { "content-type": "application/json" },
        "body": "{\"message\":\"你好\"}",
        "jsonBody": { "message": "你好" },
        "timestamp": 1715123456789
      },
      "response": {
        "status": 200,
        "statusText": "OK",
        "headers": { "content-type": "application/json" },
        "body": "{\"answer\":\"你好！有什么可以帮你的？\"}",
        "jsonBody": { "answer": "你好！有什么可以帮你的？" }
      },
      "timestamp": 1715123456789,
      "duration": 3200
    }
  ]
}
```

## 与 MSW、PollyJS 的区别

MSW 适合手写 mock handler 和构造稳定测试数据。FrontendEcho 更适合前端开发阶段直接复用真实后端响应。

PollyJS 是更完整的 HTTP record/replay 框架。FrontendEcho 的目标更窄：用更轻的接入成本解决 AI UI 开发里的重复请求问题。

## 当前限制

- 主要支持 JSON 请求/响应和纯文本响应。
- 暂不支持完整的 SSE / ReadableStream 回放。
- 暂不支持 FormData、Blob 的完整序列化。
- 不统计真实 token 成本。
- 不检测后端 system prompt、model、tools 变化。

## 推荐实践

- 只在开发环境启用。
- 只拦截 AI 相关接口，不要全量拦截所有 API。
- 提交 cassette 前确认脱敏结果。
- 团队协作时设置较短 `maxAge`。
- 后端接口结构变化后重新录制。

## License

MIT
