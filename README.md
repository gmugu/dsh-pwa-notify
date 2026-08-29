# dsh-pwa-notify

让 DeepSeek Harness（DSH）的 Web 界面变成**可安装的 PWA**，并在智能体**真正需要你**的时候发系统通知——不需要网关、不需要公网、零 npm 依赖。

参考并简化自两个插件：

- [KyoMio/dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) — 通知策略（等授权 / 等回答 / 可选回合结束）、PWA 资产、`push_notify` 工具的限流设计全部移植自它的 `dsh-push.mjs` 与 `pwa/`；本插件把它的「网关子进程 + VAPID 真 Web Push」换成「DSH 自己托管静态文件 + 页面轮询 + Service Worker 本地通知」。
- [Z-6354/dsh-mobile-hanui](https://github.com/Z-6354/dsh-mobile-hanui) — 打包方式照搬：纯 JS、无构建步骤、`cordis.patch.yml` 一行 insert、客户端 bundle 经 `dsh.client` 被发现。

## 它做什么

- **PWA 化**：DSH host 直接托管 `manifest.json` + service worker + 图标（`/_dsh/pwa-notify/*`），通过官方的 `webserver/index-inject` 事件把 `<link rel="manifest">` 注入页面。手机浏览器菜单里「添加到主屏幕」即可装成 App。
- **本地通知**：页面（或装好的 PWA）在后台运行时，智能体等你授权、等你回答会弹系统通知；点击通知回到应用。**不依赖任何推送服务**——通知由 DSH host 侧的事件监听决定、页面轮询获取、service worker 展示。
- **`notify_user` 模型工具**：模型可以在关键节点主动唤起一条通知（严格限流：每会话 60 秒 1 条、全局每小时 20 条），并附带系统提示词引导，防止它每回合都喊。

## 通知什么时候会响

策略与 dsh-zen-remote 一致——**只在真正需要你的时候响**：

| 情况 | 通知 |
| --- | --- |
| 某个工具在等你授权（超过 5 秒未被策略/自动答复器处理） | 「DSH 等你授权」，带工具名 |
| 模型调用 `ask_user_question` 在等你回答 | 「DSH 等你回答」 |
| 回合结束 | **默认不推**（`turnEnd: true` 开启）；子代理回合永远不推 |

等授权 / 等回答两类**不受最小间隔压制**——「有操作等你点头」是最不能被吞掉的通知。

页面在前台时只有等授权 / 等回答会弹（它们可能来自你没在看的会话）；页面在后台时所有通知都弹。

## 与 dsh-zen-remote 的区别

| | dsh-zen-remote | dsh-pwa-notify |
| --- | --- | --- |
| 传输 | VAPID 真 Web Push（经它的网关） | 本地轮询 + Service Worker |
| App 完全关闭后能否收到 | ✅ | ❌（页面/PWA 需在后台运行） |
| 需要网关 / 反代 / HTTPS 域名 | 需要 | 不需要 |
| 依赖 | `web-push` | 零依赖 |
| 离线缓存 | 有 | 无（刻意：避免旧 JS/CSS 缓存事故） |

已经在公网用 HTTPS 访问 DSH、且需要锁屏级推送（App 关了也要收到）→ 用 dsh-zen-remote。局域网 / localhost / 已有 HTTPS 反代但不想跑网关，接受「页面挂后台就能收」→ 用本插件。

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

装好后打开 DSH 页面会出现一次性的「🔔 DSH 通知」卡片，点「开启」授权即可。想再唤出卡片：浏览器控制台执行 `__DSH_PWA_NOTIFY__.ask()`；测试链路：`__DSH_PWA_NOTIFY__.test()`（或等价地 POST `/_dsh/pwa-notify/test`）。状态自检：`__DSH_PWA_NOTIFY__.status()`。

临时禁用（单个浏览器）：URL 加 `?pwaNotify=0`，或 `localStorage.setItem('dsh-pwa-notify','0')` 后刷新。

## 可选配置

在插件行（profile 的 `cordis.patch.yml`）里写：

```yaml
- id: dsh-pwa-notify
  config:
    turnEnd: true          # 回合结束也通知（默认 false）
    approvalGraceMs: 5000  # 授权等待宽限：装了自动审批插件时，等它答完再决定推不推
    debounceMs: 15000      # 两条自动「回合结束」通知的最小间隔（等授权/等回答不受限）
    includeSummary: false  # true 时通知带上本回合最终回复（截 120 字）和提问原文
    notifyTool: true       # false 关掉 notify_user 模型工具
```

改完重启 `dsh web`。

## 已知限制

- **需要安全上下文**：Service Worker 与 Notification API 只在 `localhost` / `127.0.0.1` 或 HTTPS 下可用。用 `http://192.168.x.x:3080` 这类明文局域网地址打开时插件会静默降级（不注册、不弹卡片）。要给手机用，走 HTTPS 反代或 Tailscale 一类的方案。
- **页面需在后台运行**：本地通知在页面 / PWA 于后台存活期间送达；系统杀掉后台标签页后就收不到了。要 App 完全关闭也收到，需要真 Web Push（见 dsh-zen-remote）。
- **iOS**：通知只对「添加到主屏幕」后的 PWA 生效，Safari 标签页内不行（系统限制，卡片会给出引导）。
- **与其它 PWA 插件竞争 scope**：`/` scope 的 service worker 只能有一个。若同时安装 dsh-zen-remote（网关注入自己的 SW），后注册者会接管；两者别同时开。
- **登录门（dsh-login-gate 等）**：轮询与静态资源路由会经过登录门校验，已登录页面正常；未登录的 SW 更新检查可能 401——不影响已注册的 SW 工作。

## 开发

```sh
npm test          # node:test：通知策略 / 环形缓冲 / 路由处理器（无需真实会话）
npm run icons     # 重新生成 pwa/icons/*.png（零依赖 PNG 编码器 + 铃铛绘制）
```

改 `src/` 直接生效（无构建）；改 `scripts/gen-icons.mjs` 后跑 `npm run icons`。结构：`src/index.js` host 半边（路由 + 事件 + 工具），`src/client.js` 浏览器半边（SW 注册 + 授权卡片 + 轮询），`pwa/` 静态资产。详见 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)，通知策略与 PWA 引导流程衍生自 dsh-zen-remote，打包结构参考 dsh-mobile-hanui，均 MIT。
