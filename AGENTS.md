# AGENTS.md — dsh-pwa-notify

> 面向 AI 编程助手 / 维护者的文档。人类读者看 [README.md](./README.md)。

## 1. 这是什么

`dsh-pwa-notify` 是 DSH 的一个 **bundle 插件**（一个包，两半代码，对用户是一个插件）：

- **host 半边** `src/index.js`（插件行 `dsh-pwa-notify`）：PWA 静态文件路由、`session/event` / `agent/turn-stopping` 监听、通知决策与环形缓冲、`notify_user` 模型工具、`webserver/index-inject` 注入 manifest link。
- **浏览器半边** `src/client.js`（同一插件行，经 `dsh.client` 发现）：Service Worker 注册、通知授权卡片、轮询循环、通知展示。

## 2. 硬约束（改动前必读）

- **无构建、无依赖**：两个参考插件里，本插件走的是 dsh-mobile-hanui 的纯 JS 路线。不要引入 TypeScript / 打包器 / npm 依赖（连 `defineTool` 都是手工内联等价物——它只是 schema 包装器，见 `buildNotifyTool` 的注释）。
- **SW 永远不加 fetch handler**：DSH 的 JS/CSS 每次部署都变且文件名不变，任何缓存策略都会造成「新 DOM + 旧 CSS」（dsh-zen-remote sw v2→v3 的事故复盘）。本插件的 SW 只做通知展示和点击聚焦。
- **通知策略保持「需要你才响」**：等授权 / 等回答恒开且不受 debounce 压制；回合结束默认关、子代理永远不推。这些语义来自 dsh-zen-remote 的行为变更历史（1.0.3 起回合结束默认不推），不要「顺手改默认值」。
- **决策层必须是纯函数**：`decideNotification` / `turnSummary` / `assistantText` / `pendingQuestionText` 全部纯函数导出，测试不经真实会话（建真实会话耗 token，是工作区硬约束）。宿主侧接线（`apply`）只做薄封装。
- **工具名是 `notify_user` 不是 `push_notify`**：刻意与 dsh-zen-remote 区分（避免同装冲突），且语义不同（本地通知，不是推送）。描述里必须写清 LOCAL-ONLY 送达范围。
- **图标是生成物**：改 `scripts/gen-icons.mjs` 后跑 `npm run icons` 并提交 `pwa/icons/`。PNG 编码器手写在脚本里（CRC32 + zlib），别引入 sharp 之类的依赖。

## 3. 加载与工作机制

### host 侧

- `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`，一行 insert（`id/name: dsh-pwa-notify`）。
- 路由：`webServer.register({ kind: 'prefix', path: '/_dsh/pwa-notify' })`，在 `ctx.inject(['webServer'], ...)` 里注册——没有 webServer 的组合（Electron）行照常加载，只是无路由。
- `sw.js` 响应必须带 `Service-Worker-Allowed: /`，否则脚本在 `/_dsh/pwa-notify/` 下无权控制 scope `/`。
- manifest link 通过 `ctx.on('webserver/index-inject', ...)` 的结构化注入行加入 index.html（`{ kind: 'html', placement: 'head' }`）。
- `tools` / `systemPrompt` 同样用 `ctx.inject` 延迟挂载：这些服务可能由后加载的插件提供，`ctx.get` 在加载顺序不利时读空（dsh-zen-remote 实测过的坑）。

### client 侧

- `src/client.js` 以 `window.__ModuleLoader__.load({ id, factory })` 注册；factory 内不用 React（授权卡片是纯 DOM，样式内联，来自 zen-remote `pwa/inject.js` 的成熟形态）。
- 轮询协议：首次 poll（`since=0`）只采纳 `seq` 基线，**不回放历史**；之后 `seq` 之后的条目在 `document.hidden` 或 kind ∈ {approval, question} 时经 `registration.showNotification()` 展示。
- 所有 DOM / 定时器 / 监听器在 `ctx.effect` 的清理函数里拆除；插件停止时还会注销本插件的 SW（按 `scriptUrl` 路径前缀判断，不误删别人的）。

## 4. 命令

```sh
npm test        # node --test：12 个用例（策略、缓冲、路由、同源校验）
npm run icons   # 重新生成 pwa/icons/*.png
```

## 5. 已知取舍记录

- **轮询而非 SSE/WebSocket**：SSE 长连接在后台标签页会被浏览器掐掉，轮询（后台 8s / 前台 40s）更抗 throttling，实现也更小。代价是平均 4 秒延迟——对「等你授权」这类通知可接受。
- **`approvalGraceMs` 默认 5s**：模型答复器（dsh-auto-approve 类）实测平均 2.4s；窗口太短会推「等你授权」但框从未出现（zen-remote 踩过）。
- **同源校验只盖 `POST /test`**：poll 与静态文件是只读的，GET 不需要 CSRF 防护；`notify_user` 工具在 host 内部入队，不经过浏览器。
- **登录门兼容**：本部署装有 dsh-login-gate 时，全部路由经它过鉴权，已登录页面无感；唯一影响是未登录 SW 更新检查可能 401（无功能影响）。

## 6. 发布

`npm version patch`（不要 `--no-git-tag-version`，`github:` 安装 spec 依赖 tag）→ `git push --tags` → `npm publish --access public`。
