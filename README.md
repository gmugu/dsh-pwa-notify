# dsh-pwa-notify

让 DeepSeek Harness（DSH）的 Web 界面变成**可安装的 PWA**，并在智能体**真正需要你**的时候发系统通知——**含真·Web Push（App 被系统杀死也能收到锁屏推送）**，不需要网关子进程、零 npm 依赖。

参考并简化自两个插件：

- [KyoMio/dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) — 通知策略（等授权 / 等回答 / 可选回合结束）、PWA 资产、`push_notify` 工具的限流设计全部移植自它的 `dsh-push.mjs` 与 `pwa/`；推送协议（RFC 8291 aes128gcm 加密 + RFC 8292 VAPID 签名）在功能上对齐它的 `web-push` 用法，但这里是**用 node:crypto 手写实现**（`src/webpush.js`，以 RFC 8291 Appendix A 已知答案向量为测试基准），由 DSH host 自己发送——不需要它的网关子进程。
- [Z-6354/dsh-mobile-hanui](https://github.com/Z-6354/dsh-mobile-hanui) — 打包方式照搬：纯 JS、无构建步骤、`cordis.patch.yml` 一行 insert、客户端 bundle 经 `dsh.client` 被发现。

## 它做什么

- **PWA 化**：DSH host 直接托管 `manifest.json` + service worker + 图标（`/_dsh/pwa-notify/*`），通过官方的 `webserver/index-inject` 事件把 `<link rel="manifest">` 注入页面。手机浏览器菜单里「添加到主屏幕」即可装成 App。
- **真·Web Push**：HTTPS 访问时，页面/主屏 PWA 用 VAPID 公钥订阅推送；智能体需要你时 DSH host 直接向推送服务（FCM/APNs/Mozilla 的系统级通道）发出 aes128gcm 端到端加密通知——**即使 App 已被 iOS 杀掉也能到锁屏**。
- **本地轮询兜底**：未订阅推送的浏览器（或 `push: false` 时）仍有轮询通道——页面在后台运行时经 Service Worker 弹通知。订阅成功后自动停用本地展示，两条通道不会重复响。
- **`notify_user` 模型工具**：模型可以在关键节点主动唤起一条通知（严格限流：每会话 60 秒 1 条、全局每小时 20 条），并附带系统提示词引导，防止它每回合都喊。

## 通知什么时候会响

策略与 dsh-zen-remote 一致——**只在真正需要你的时候响**：

| 情况 | 通知 |
| --- | --- |
| 某个工具在等你授权（超过 5 秒未被策略/自动答复器处理） | 「DSH 等你授权」，带工具名 |
| 模型调用 `ask_user_question` 在等你回答 | 「DSH 等你回答」 |
| 回合结束 | **默认不推**（`turnEnd: true` 开启）；子代理回合永远不推 |

等授权 / 等回答两类**不受最小间隔压制**——「有操作等你点头」是最不能被吞掉的通知。

推送通道的通知总是弹（SW 的 `push` 事件与页面状态无关）；轮询通道在前台时只弹等授权/等回答（可能来自你没在看的会话），后台时全弹。

## 与 dsh-zen-remote 的区别

| | dsh-zen-remote | dsh-pwa-notify |
| --- | --- | --- |
| 传输 | VAPID 真 Web Push（经它的网关子进程） | VAPID 真 Web Push（DSH host 自己发）+ 轮询兜底 |
| App 完全关闭后能否收到 | ✅ | ✅（已订阅推送的设备） |
| 需要网关子进程 | 需要 | 不需要 |
| 需要 HTTPS | 是（经它的网关） | 是（仅推送订阅需要；HTTP 下自动退化为轮询通道） |
| 依赖 | `web-push` | 零依赖（node:crypto 手写 RFC 8291/8292） |
| 远程访问方案 | 自带配对码网关 | 与你现有的反代/登录门共存 |
| 离线缓存 | 有 | 无（刻意：避免旧 JS/CSS 缓存事故） |

两者不要同时开（`/` 作用域的 service worker 只能有一个）。

## 安装

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-pwa-notify        # 或 link:/path/to/dsh-pwa-notify 本地开发
```

然后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组里加入 `"dsh-pwa-notify"`，重启 `dsh web`：

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-pwa-notify"
  ] } }
}
```

装好后打开 DSH 页面会出现一次性的「🔔 DSH 通知」卡片，点「开启」授权即可（HTTPS 下会同时订阅真推送）。想再唤出卡片：浏览器控制台执行 `__DSH_PWA_NOTIFY__.ask()`；测试链路：`__DSH_PWA_NOTIFY__.test()`（或等价地 POST `/_dsh/pwa-notify/test`）。状态自检：`__DSH_PWA_NOTIFY__.status()`（含 `pushSubscribed`）。

**iPhone 上的完整流程**（iOS 的推送只给主屏 PWA，Safari 标签页拿不到）：

1. Safari 打开你的 HTTPS 域名 → 分享菜单 →「添加到主屏幕」
2. 从主屏图标打开 → 出现「🔔 DSH 通知」卡片 → 点「开启」
3. 看到「已订阅系统级推送」即完成——此后即使 iOS 杀掉这个 App，通知照样到锁屏

临时禁用（单个浏览器）：URL 加 `?pwaNotify=0`，或 `localStorage.setItem('dsh-pwa-notify','0')` 后刷新。

## 可选配置

在插件行（profile 的 `cordis.patch.yml`）里写：

```yaml
- id: dsh-pwa-notify
  config:
    vapidSubject: https://dsh.example.com  # iOS 必须：真实的 mailto: 或 https: 联系方式，占位符会被 Apple 拒发
    turnEnd: true          # 回合结束也通知（默认 false）
    approvalGraceMs: 5000  # 授权等待宽限：装了自动审批插件时，等它答完再决定推不推
    debounceMs: 15000      # 两条自动「回合结束」通知的最小间隔（等授权/等回答不受限）
    includeSummary: false  # true 时通知带上本回合最终回复（截 120 字）和提问原文
    notifyTool: true       # false 关掉 notify_user 模型工具
    push: true             # false 关掉 Web Push，只留轮询通道
```

改完重启 `dsh web`。VAPID 密钥对与订阅列表持久化在 `$DSH_HOME/pwa-notify-state.json`（删掉它 = 作废所有已订阅设备，会自动重新生成密钥）。

## 已知限制

- **推送订阅需要 HTTPS**（安全上下文硬要求）：`http://IP:端口` 打开时自动退化为轮询通道（页面后台挂着才能收到）。
- **推送可达性**：DSH host 需能访问外网推送服务（FCM/APNs/Mozilla）；推送服务商只见 aes128gcm 密文。
- **iOS**：推送只对「添加到主屏幕」后的 PWA 生效（系统限制，卡片会给出引导）。
- **与其它 PWA 插件竞争 scope**：`/` scope 的 service worker 只能有一个。若同时安装 dsh-zen-remote（网关注入自己的 SW），后注册者会接管；两者别同时开。
- **登录门（dsh-login-gate 等）**：轮询/订阅/静态资源路由会经过登录门校验，已登录页面正常；未登录的 SW 更新检查可能 401——不影响已注册的 SW 与推送（推送唤醒不经过 DSH）。

## 开发

```sh
npm test          # node:test：通知策略 / 环形缓冲 / 路由 / RFC 8291 已知答案向量 / 推送广播（无需真实会话）
npm run icons     # 重新生成 pwa/icons/*.png（零依赖 PNG 编码器 + 铃铛绘制）
```

改 `src/` 直接生效（无构建）；改 `scripts/gen-icons.mjs` 后跑 `npm run icons`。结构：`src/index.js` host 半边（路由 + 事件 + 工具 + 推送编排），`src/webpush.js` Web Push 协议（VAPID / aes128gcm / 订阅状态），`src/client.js` 浏览器半边（SW 注册 + 授权卡片 + 订阅 + 轮询），`pwa/` 静态资产。详见 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)，通知策略与 PWA 引导流程衍生自 dsh-zen-remote，打包结构参考 dsh-mobile-hanui，均 MIT。
