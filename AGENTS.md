# AGENTS.md — dsh-pwa-notify

> 面向 AI 编程助手 / 维护者的文档。人类读者看 [README.md](./README.md)。

## 1. 这是什么

`dsh-pwa-notify` 是 DSH 的一个 **bundle 插件**（一个包，两半代码，对用户是一个插件）：

- **host 半边** `src/index.js`（插件行 `dsh-pwa-notify`）：PWA 静态文件路由、`session/event` / `agent/turn-stopping` 监听、通知决策（纯函数）+ Web Push 广播、`notify_user` 模型工具、`webserver/index-inject` 注入 manifest link 与 VAPID 公钥。
- **协议半边** `src/webpush.js`：VAPID 密钥（RFC 8292 ES256）、aes128gcm 载荷加密（RFC 8291）、订阅状态持久化与广播（404/410 自动清理）。
- **浏览器半边** `src/client.js`（同一插件行，经 `dsh.client` 发现）：Service Worker 注册、通知授权卡片、推送订阅与回访 resync——页面自身无展示路径。

## 2. 硬约束（改动前必读）

- **无构建、无依赖**：两个参考插件里，本插件走的是 dsh-mobile-hanui 的纯 JS 路线。不要引入 TypeScript / 打包器 / npm 依赖（连 `defineTool` 都是手工内联等价物——它只是 schema 包装器；Web Push 也是 node:crypto 手写，见下）。
- **RFC 8291 已知答案向量是加密代码的唯一护栏**：`src/webpush.js` 的 `encryptPayload` 改任何一行（HKDF 接线、点编码、GCM 用法、header 布局），`test/webpush.test.mjs` 的 Appendix A 向量必须仍然逐字节通过。没有它，手写加密错了只会在真手机上静默失败。
- **VAPID 密钥必须持久化**：`$DSH_HOME/pwa-notify-state.json` 里的密钥对一旦重新生成，所有已订阅设备全部失效。状态文件原子写（tmp+rename），`createPushState` 的状态是每实例闭包——**不要**用共享默认对象浅拷贝初始化（曾因此让一个实例的订阅漏进下一个实例）。
- **推送是唯一通知通道**（用户决定移除轮询兜底）：事件腿统一走 `apply` 里的 `emit()`（fire-and-forget 广播）；`notify_user` 工具与 `/test` 直接 `await pushState.broadcast()` 拿真实 2xx 送达数。不要 reintroduce 缓冲/轮询通道——一条推送失败即丢失是**已接受的取舍**，设备下次打开应用时自动重订阅自愈。
- **SW 永远不加 fetch handler**：DSH 的 JS/CSS 每次部署都变且文件名不变，任何缓存策略都会造成「新 DOM + 旧 CSS」（dsh-zen-remote sw v2→v3 的事故复盘）。本插件的 SW 只做通知展示（push 事件 + showNotification）和点击聚焦。
- **通知策略保持「需要你才响」**：等授权 / 等回答默认开且不受 debounce 压制（设置卡片可关——用户明确要求的开关）；回合结束默认关、子代理永远不推。默认语义来自 dsh-zen-remote 的行为变更历史（1.0.3 起回合结束默认不推），不要「顺手改默认值」。
- **决策层必须是纯函数**：`decideNotification` / `turnSummary` / `assistantText` / `pendingQuestionText` 全部纯函数导出，测试不经真实会话（建真实会话耗 token，是工作区硬约束）。宿主侧接线（`apply`）只做薄封装。
- **工具名是 `notify_user` 不是 `push_notify`**：刻意与 dsh-zen-remote 区分（避免同装冲突）。注册包 try/catch：与部署里同名工具撞名时降级为告警，不许把插件行带崩。
- **schemastery 依赖只经 symlink**：`node_modules/@deepseek-ai/schemastery → 宿主 dsh 安装内的同名包`（dsh-login-gate 同款做法），供 `settings.register` 的 schema 使用；包声明为 optional peerDependency，npm 安装场景由 profile 图解析。**不要**在包里 npm install 真实依赖，也不要删除这个 symlink（settings 命名空间会挂）。
- **设置是双层的**：用户层（开关 + 文案模板）走 `settings.register('dsh-pwa-notify', SettingsSchema)`，`scope.watch` 热更新 `apply` 里的 `cfg`；行配置只提供静态项（grace/debounce/subject/push/tool）和 `turnEndPush`/`includeSummary` 的 base 初始值。`renderTexts` 是纯函数，`decideNotification` 和 `/test` 预览共用——改文案逻辑必须同时过两边的测试。
- **index.html 改写走 tapIndex，注入走 index-inject**：viewport meta / manifest link 这类要**编辑既有标签**的改动只能用 `webServer.tapIndex`（结构化注入行只会追加）；tapIndex 在注入之后运行，`stripExistingManifestLink` 必须保留自己的 `/_dsh/pwa-notify/manifest.json`（先注入=第一个=被浏览器采用）。安全区 CSS 打在 `body` 上且必须 `box-sizing:border-box`——app 是 `html,body,#root{height:100%}` 无全局 border-box，content-box padding 会多出一条可滚动溢出条；slot 包装层是 display:contents，padding 无效（zen-remote 实测）。CSS 全部包在 `@media (display-mode: standalone)` 里，桌面/标签页逐像素不变。
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
- 页面代码**没有任何展示路径**：通知全部由 SW 的 `push` 事件展示；页面只负责注册 SW、授权卡片、订阅与回访 resync。
- 所有 DOM / 监听器在 `ctx.effect` 的清理函数里拆除；插件停止时还会注销本插件的 SW（按 `scriptUrl` 路径前缀判断，不误删别人的）。

## 4. 命令

```sh
npm test        # node --test：21 个用例（策略、开关、文案模板、路由、index 改写、RFC 8291 向量、VAPID JWT、推送广播）
npm run icons   # 重新生成 pwa/icons/*.png
```

## 5. 已知取舍记录

- **手写 Web Push 而不是 `web-push` 依赖**：本插件经 `link:` 安装，pnpm 不会为 link 包装它自己的依赖；手写 RFC 8291/8292（node:crypto 全有原语）+ RFC 已知答案向量测试，比在插件目录里养第二套 node_modules 可靠。
- **Node 的 `dsaEncoding` 有两种拼写**：`'ieee-p1363'`（v22.x 实测）与 `'ieee-p1363-format'`（上游），`es256RawSign` 两种都试。undici 的 fetch **不允许手设 `Content-Length`**（报 invalid content-length header），长度由 body 自动推导。
- **移除轮询是用户决策**：安全网（FCM 不可达、订阅过期时开着的页面仍能收到）换简单性。大陆服务器直连 FCM 不通时通知即丢，直到设备下次打开应用自动重订阅；iPhone/APNs 不受影响。
- **`approvalGraceMs` 默认 5s**：模型答复器（dsh-auto-approve 类）实测平均 2.4s；窗口太短会推「等你授权」但框从未出现（zen-remote 踩过）。
- **同源校验只盖 POST（test/subscribe/unsubscribe）**：静态文件是只读的，GET 不需要 CSRF 防护；推送发送在 host 内部发起，不经过浏览器。
- **登录门兼容**：本部署装有 dsh-login-gate 时，全部路由经它过鉴权，已登录页面无感；推送唤醒走推送服务商→系统→SW，完全不经过 DSH，登录门不影响锁屏送达。

## 6. 发布

`npm version patch`（不要 `--no-git-tag-version`，`github:` 安装 spec 依赖 tag）→ `git push --tags` → `npm publish --access public`。
