# AGENTS.md — dsh-pwa-notify

> 面向 AI 编程助手 / 维护者的文档。人类读者看 [README.md](./README.md)。

## 0. 协作规则（最高优先级）

- **git 提交必须等用户确认**：改完代码/文档先跑测试、给出变更摘要，用户明确点头后才执行 `git commit`；禁止顺手提交。
- **一个功能一条提交**：一次改动只含一个功能（含它的测试与文档同步）；多功能混合的提交要先拆分。
- **push 永远由用户执行**：本机没有 GitHub 凭据，且推送时机由用户决定。

## 1. 这是什么

`dsh-pwa-notify` 是 DSH 的一个 **bundle 插件**（一个包，两半代码，对用户是一个插件）：

- **host 半边** `src/index.js`（插件行 `dsh-pwa-notify`）：PWA 静态文件路由、事件监听（`session/event` 的授权/提问/计划/目标 + `agent/turn-stopping` + `agent/error` + `jobs.onJobDone`）、通知决策（纯函数）+ Web Push 广播、`notify_user` 模型工具、settings 命名空间、`webserver/index-inject` 注入与 tapIndex 改写。
- **协议半边** `src/webpush.js`：VAPID 密钥（RFC 8292 ES256）、aes128gcm 载荷加密（RFC 8291）、订阅状态持久化与广播（404/410 自动清理）。
- **浏览器半边** `src/client.js`（同一插件行，经 `dsh.client` 发现）：Service Worker 注册、通知授权卡片、推送订阅与回访 resync（通知展示全在 SW，页面自身无展示路径），以及 Settings「通知推送」卡片（React，settings.section 槽 + settingsScope）。

## 2. 硬约束（改动前必读）

- **无构建、依赖极简**：走 dsh-mobile-hanui 的纯 JS 路线——不引入 TypeScript / 打包器 / 运行时依赖（`defineTool` 是手工内联等价物，Web Push 用 node:crypto 手写）；唯一例外是 settings schema 必需的 `@deepseek-ai/schemastery`（见下条）。新增依赖前先问：能不能 node: 内置解决。
- **RFC 8291 已知答案向量是加密代码的唯一护栏**：`src/webpush.js` 的 `encryptPayload` 改任何一行（HKDF 接线、点编码、GCM 用法、header 布局），`test/webpush.test.mjs` 的 Appendix A 向量必须仍然逐字节通过。没有它，手写加密错了只会在真手机上静默失败。
- **VAPID 密钥必须持久化**：`$DSH_HOME/pwa-notify-state.json` 里的密钥对一旦重新生成，所有已订阅设备全部失效。状态文件原子写（tmp+rename），`createPushState` 的状态是每实例闭包——**不要**用共享默认对象浅拷贝初始化（曾因此让一个实例的订阅漏进下一个实例）。
- **推送是唯一通知通道**（用户决定移除轮询兜底）：事件腿统一走 `apply` 里的 `emit()`（fire-and-forget 广播）；`notify_user` 工具与 `/test` 直接 `await pushState.broadcast()` 拿真实 2xx 送达数。不要 reintroduce 缓冲/轮询通道——一条推送失败即丢失是**已接受的取舍**，设备下次打开应用时自动重订阅自愈。
- **SW 永远不加 fetch handler**：DSH 的 JS/CSS 每次部署都变且文件名不变，任何缓存策略都会造成「新 DOM + 旧 CSS」（dsh-zen-remote sw v2→v3 的事故复盘）。本插件的 SW 只做通知展示（push 事件 + showNotification）和点击聚焦。
- **通知策略保持「需要你才响」**：**免防打扰压制**的腿 = 等授权 / 等回答（**含计划审阅**，exit_plan_mode 与 ask_user_question 共用 userQuestions.ask() 阻塞通道，按 tool/call 名字白名单识别）/ 回合出错（agent/error，仅顶层会话）/ 目标受阻（update_goal action=blocked）；**受压制**的腿 = 回合结束（默认关）与后台任务结算（默认开）。设置卡片可关各腿。子代理的完成/出错永远不推。默认语义源自 dsh-zen-remote（1.0.3 起回合结束默认不推），不要「顺手改默认值」。
- **等待类工具按名字白名单识别**：`ASK_USER_TOOL` / `EXIT_PLAN_TOOL`（再加 GOAL_TOOL 的 blocked 动作）。userQuestions 服务本身没有事件面（只有 ask() API），全 DSH 的 asker 只有这两个——**上游新增等待类工具时必须扩这个名单**，否则静默漏通知。
- **决策层必须是纯函数**：`decideNotification` / `turnSummary` / `assistantText` / `pendingQuestionText` 全部纯函数导出，测试不经真实会话（建真实会话耗 token，是工作区硬约束）。宿主侧接线（`apply`）只做薄封装。
- **工具名是 `notify_user` 不是 `push_notify`**：刻意与 dsh-zen-remote 区分（避免同装冲突）。注册包 try/catch：与部署里同名工具撞名时降级为告警，不许把插件行带崩。
- **schemastery 是正式 dependencies**：开发目录跑一次 `npm install` 装真实副本（registry 可达），打包安装的副本由 profile 解析同一依赖。**不要**手工往 node_modules 里放 symlink 代替安装——`npm pack`/npm 脚本加载依赖树时会按 package.json 收敛 node_modules，手工 symlink 会被清掉（踩过：symlink 蒸发 → 测试全挂 ERR_MODULE_NOT_FOUND）。
- **设置是双层的（v0.8.0 起开关-only）**：用户层走 `settings.register('dsh-pwa-notify', SettingsSchema)`（六开关 + includeSummary，**无文案模板**——自定义功能已按用户要求移除，文案为 `DEFAULT_TEXTS` 固定），`scope.watch` 热更新 `apply` 里的 `cfg`；行配置只提供静态项（grace/debounce/subject/push/tool）和 `turnEndPush`/`includeSummary` 的 base 初始值。`renderTexts` 是纯函数，`decideNotification` 和 `/test` 预览共用。
- **/test 预览必须按当前实时配置渲染**：不强制 includeSummary——测试按钮收到什么，真实推送就是什么（用户明确要求）。改预览逻辑不许重新引入「强制摘要」的覆盖。
- **推送开启入口只在设置卡片**（v0.8.0 起）：无首载弹卡、无 ask() API；设置卡片「推送状态」区块是唯一开启入口，已订阅置灰。不要重新引入页面弹卡。
- **index.html 改写走 tapIndex，注入走 index-inject**：要**编辑既有标签**的改动只能用 `webServer.tapIndex`（结构化注入行只会追加）；tapIndex 在注入之后运行，`stripExistingManifestLink` 必须保留自己的 `/_dsh/pwa-notify/manifest.json`（先注入=第一个=被浏览器采用）。**不要**再尝试 viewport-fit=cover / 安全区 padding 的全屏沉浸方案——v0.5.0 做过、v0.6.2 整体回退：fixed 定位的应用骨架不吃 body padding，iOS 首帧 env() 仍是 0，实测整个 UI 顶到状态栏底下。保留的 shell CSS 只有无布局影响的两条（overscroll 防误刷新、输入框 ≥16px 防聚焦缩放），包在 `@media (display-mode: standalone)` 里。
- **图标是生成物（DSH 鲸鱼）**：`pwa/icons/whale.svg` 是从 `@deepseek-ai/dsh-web-frontend` 的 favicon vendor 进来的单 path 鲸鱼（DSH 品牌资产）；`npm run icons` 用**宿主安装里的 sharp**（绝对路径加载，仅生成期，不是包依赖）把「渐变圆角块 + 鲸鱼」整图栅格化。宿主 sharp 不在时回退到零依赖的手绘铃铛（手写 PNG 编码器 CRC32 + zlib）。**不要**把 sharp 写进 dependencies；换图改 whale.svg 或排版参数后重跑并提交全部 PNG。
- **iOS 主屏图标只认 apple-touch-icon**：manifest icons 只服务 Android/桌面 Chrome；Safari 装主屏时读 `<link rel="apple-touch-icon">`（我们注入 180 全方形 PNG，**不能自带圆角/透明**——iOS 自己切圆角，预切会露黑角），没有这个标签就退化为页面截图。且 iOS 在**安装时刻**缓存图标：换图后必须删掉主屏图标重加才生效。

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
npm test        # node --test：26 个用例（策略、开关、文案模板、路由、index 改写、RFC 8291 向量、VAPID JWT、推送广播）
npm run icons   # 重新生成 pwa/icons/*.png
```

## 5. 已知取舍记录

- **手写 Web Push 而不是 `web-push` 依赖**：node:crypto 全有原语，加上 RFC 已知答案向量测试兜底，比引入 web-push 及其传递依赖更轻更可靠（早期还因 link: 安装不装依赖；tarball 安装后已无此约束，零传递依赖的好处仍在）。
- **Node 的 `dsaEncoding` 有两种拼写**：`'ieee-p1363'`（v22.x 实测）与 `'ieee-p1363-format'`（上游），`es256RawSign` 两种都试。undici 的 fetch **不允许手设 `Content-Length`**（报 invalid content-length header），长度由 body 自动推导。
- **移除轮询是用户决策**：安全网（FCM 不可达、订阅过期时开着的页面仍能收到）换简单性。大陆服务器直连 FCM 不通时通知即丢，直到设备下次打开应用自动重订阅；iPhone/APNs 不受影响。
- **`approvalGraceMs` 默认 5s**：模型答复器（dsh-auto-approve 类）实测平均 2.4s；窗口太短会推「等你授权」但框从未出现（zen-remote 踩过）。
- **同源校验只盖 POST（test/subscribe/unsubscribe）**：静态文件是只读的，GET 不需要 CSRF 防护；推送发送在 host 内部发起，不经过浏览器。
- **登录门兼容**：本部署装有 dsh-login-gate 时，全部路由经它过鉴权，已登录页面无感；推送唤醒走推送服务商→系统→SW，完全不经过 DSH，登录门不影响锁屏送达。

## 6. 安装模型（开发 ≠ 运行）

- **项目目录只是开发区**：live DSH 跑的是 `npm run install:profile`（= `scripts/install-to-profile.mjs`：测试 → pack → 落位 `$DSH_HOME/plugins-packages/dsh-pwa-notify-current.tgz`（**固定文件名**，profile 依赖指向它，版本间不腐烂）→ profile 里 `pnpm add file:...`）。tarball 是真实副本：装完之后改项目目录对运行中的 DSH 零影响。
- **切换依赖必须 remove + add**：`pnpm add` 不会刷新已存在的 symlink——先 `pnpm remove dsh-pwa-notify` 再 add，否则 node_modules 里残留指回项目目录的旧链接（踩过：lockfile specifier 更新了、version 仍是 link:，测试全绿但跑的是源码目录）。
- **npm pack 不含 node_modules**（files 白名单也拦不住这条 npm 硬规则），所以见上条 schemastery 双供给。
- 沙箱/EROFS：pnpm 写 profile 失败时报 `[EROFS] read-only file system` 且 exit 226——不是包的问题，是当前 shell 没有该目录写权限。

## 7. 发布

- 仓库：https://github.com/gmugu/dsh-pwa-notify（`git push origin main && git push --tags`）。
- GitHub 安装 spec 依赖 tag 存在：每次发版 `npm version patch`（不要 `--no-git-tag-version`）→ push main + tags。
- tarball 分发：`npm pack` 出的 tgz 直接发人，`dsh plugin --profile web add ./xxx.tgz` 安装。
- npm 发布（如需）：tag push 后 `npm publish --access public`（prepublishOnly 自动跑测试）。
