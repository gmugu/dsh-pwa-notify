# dsh-pwa-notify

让 DeepSeek Harness（DSH）的 Web 界面变成**可安装的 PWA**，并在智能体**真正需要你**的时候发系统通知——**真·Web Push，App 被 iOS 杀掉也能收到锁屏推送**，不需要网关子进程，不依赖 `web-push`（推送协议用 node:crypto 手写实现）。

参考并致谢两个插件：

- [KyoMio/dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) — 通知策略（等授权 / 等回答 / 可选回合结束、`notify` 工具限流）与 PWA 资产形态移植自它的 `dsh-push.mjs` 与 `pwa/`；推送协议（RFC 8291 aes128gcm + RFC 8292 VAPID）由 DSH host 直接实现，无需它的网关子进程。
- [Z-6354/dsh-mobile-hanui](https://github.com/Z-6354/dsh-mobile-hanui) — 打包方式参考：纯 JS、无构建步骤、`cordis.patch.yml` 一行 insert、客户端 bundle 经 `dsh.client` 被发现。

## 它做什么

- **PWA 化**：DSH host 托管 `manifest.json` + service worker + 图标（`/_dsh/pwa-notify/*`），并把 manifest / apple-touch-icon 注入页面——手机浏览器「添加到主屏幕」即装成 App，图标用 DSH 鲸鱼。
- **真·Web Push**：HTTPS 下页面/主屏 PWA 用 VAPID 公钥订阅推送；智能体需要你时 host 直接向推送服务（FCM/APNs/Mozilla）发 aes128gcm 端到端加密通知。推送是**唯一通知通道**（无轮询兜底）：一条推送发送失败即丢失，设备下次打开应用自动重订阅自愈。
- **设置界面**：DSH 设置页「通知推送」卡片——推送状态（唯一的开启入口，已订阅置灰）、六类推送开关、对话摘要开关、按当前配置发真通知的测试按钮（勾不勾摘要，测试和真实推送文案完全一致）、订阅设备管理。即时生效，持久化在 DSH 设置存储。
- **`notify_user` 模型工具**：模型可在关键节点主动唤起通知（限流：每会话 60 秒 1 条、全局每小时 20 条），`delivered` 返回真实送达数。

## 通知什么时候会响

**只在真正需要你的时候响**（策略沿用 dsh-zen-remote 的取舍）：

| 情况 | 通知 |
| --- | --- |
| 工具等你授权（5 秒内未被策略/自动审批处理） | 「DSH 等你授权」，带工具名 |
| `ask_user_question` 等你回答 | 「DSH 等你回答」 |
| 回合出错 / 目标受阻 / 后台任务结束 | 默认推（设置卡片可关） |
| 回合结束 | 默认不推（设置卡片开启）；子代理永远不推 |

等授权 / 等回答不受防打扰间隔压制。通知全部由 Service Worker 的 `push` 事件展示，与页面状态无关。

## 安装

任选其一。`dsh plugin add` 会自动把插件登记进 `dsh.profile.bundles`；手动 `pnpm add` 的方式则还需在 `~/.dsh/profiles/web/package.json` 的 bundles 数组里加一行 `"dsh-pwa-notify"`。装完**重启 dsh web** 生效。

```sh
# ① GitHub（推荐；#tag 指向版本，tag 必须已 push，否则 404）
dsh plugin --profile web add github:gmugu/dsh-pwa-notify#v0.6.2

# ② 本地 tarball（npm pack 的产物，私下分发）
dsh plugin --profile web add ./dsh-pwa-notify-0.6.2.tgz

# ③ npm（发布后）
dsh plugin --profile web add dsh-pwa-notify
```

也接受完整 URL / SSH 私仓形式（`https://github.com/gmugu/dsh-pwa-notify.git`、`git@github.com:gmugu/dsh-pwa-notify.git`，私仓需收件方有读权限）。升级 = 换新 tag / 新 tarball 重装 + 重启；卸载 = `dsh plugin --profile web remove dsh-pwa-notify` + 重启。

**本仓库开发部署**（改代码 → 上线，与上面分离）：

```sh
git clone https://github.com/gmugu/dsh-pwa-notify && cd dsh-pwa-notify
npm install                     # 装 schemastery（本地测试需要）
npm run install:profile         # 测试 → npm pack → 落位 → 装进本机 profile
sudo systemctl restart dsh      # 或你的进程管理方式
```

### 装好之后

页面**不会弹任何授权卡**（v0.8.0 起低打扰）。打开 设置 → 通知推送 → 推送状态 → 点「开启通知」即完成；已开启的设备该按钮置灰。控制台可用：`__DSH_PWA_NOTIFY__.test()` 测试链路、`.status()` 自检（含 `pushSubscribed`）。

**iPhone 完整流程**（iOS 推送只给主屏 PWA，Safari 标签页拿不到）：

1. Safari 打开你的 HTTPS 域名 → 分享 →「添加到主屏幕」
2. 从主屏图标打开 → 设置 → 通知推送 → 「开启通知」
3. 按钮变为置灰「已开启推送」即完成——之后即使 iOS 杀掉 App，通知照样到锁屏

单个浏览器临时禁用：URL 加 `?pwaNotify=0`，或 `localStorage.setItem('dsh-pwa-notify','0')` 后刷新。

## 配置

**开关**：设置页「通知推送」卡片，即时生效（通知文案为内置固定文案，`{question}/{summary}` 内容随「带对话摘要」开关变化）。

**静态项**（profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-pwa-notify
  config:
    vapidSubject: https://dsh.example.com  # iOS 必须：真实 mailto:/https:，占位符会被 Apple 拒发
    approvalGraceMs: 5000  # 授权宽限：装了自动审批插件时等它答完再推
    debounceMs: 15000      # 两条「回合完成」的最小间隔（等授权/等回答不受限）
    notifyTool: true       # false 关掉 notify_user 工具
    push: true             # false 全关推送
```

`turnEnd` / `includeSummary` 可作初始值写在行里；设置卡片保存过之后以设置存储为准。VAPID 密钥与订阅列表在 `$DSH_HOME/storages/dsh-pwa-notify.json`（删掉 = 作废全部已订阅设备并重新生成密钥）。

## 已知限制

- **需要 HTTPS**（安全上下文硬要求）：`http://IP:端口` 访问时无通知（SW/推送订阅均不可用，卡片也不会出现）。
- **推送可达性**：DSH host 需能访问推送服务（FCM/APNs/Mozilla）。iPhone 走 APNs（大陆可达）；Chrome/安卓设备的端点在 FCM，服务器直连不通时通知即丢（无轮询兜底）。
- **iOS**：推送只对「添加到主屏幕」后的 PWA 生效（系统限制，卡片会引导）。换图标后已装的主屏 App 需删除重加才会更新（iOS 在安装时缓存图标）。
- **与其它 PWA 插件竞争 scope**：`/` 作用域的 service worker 只能有一个，别与 dsh-zen-remote 同时开。
- **登录门（dsh-login-gate 等）**：插件路由经过登录门校验，已登录页面无感；推送唤醒不经过 DSH，锁屏送达不受影响。
- **一条推送失败即丢失**（0.3.0 起的既定取舍）：无重放、无轮询兜底；设备自动重订阅自愈。

## 开发

```sh
npm install         # 首次：装 schemastery（settings schema，本地测试必需）
npm test            # node:test：31 个用例（策略/开关/路由/index 改写/RFC 8291 向量/VAPID JWT/推送广播/设置卡片点击冒烟）
npm run icons       # 重新生成 pwa/icons/*.png（鲸鱼主路径用宿主 sharp，缺失时回退手绘铃铛）
```

结构：`src/index.js` host 半边（路由 + 事件 + 设置命名空间 + `notify_user` 工具 + 推送编排）、`src/webpush.js` 推送协议（VAPID / aes128gcm / 订阅状态）、`src/client.js` 浏览器半边（SW 注册 + 授权卡片 + 订阅 + 设置卡片）、`pwa/` 静态资产。维护者文档见 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)。通知策略与 PWA 引导流程衍生自 dsh-zen-remote，打包结构参考 dsh-mobile-hanui，均 MIT；鲸鱼图标为 DSH 品牌资产（`@deepseek-ai/dsh-web-frontend`）。
