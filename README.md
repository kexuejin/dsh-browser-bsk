# dsh-browser-bsk

给 DeepSeek Harness 提供 **browser 能力 seam（`ctx.browser`）的 bsk 后端**：把本机 `browser-skill` 用的 `bsk` CLI 包成一个浏览器服务，供那些 `inject` 了 `browser` 的插件注入。

## 为什么需要它

有些插件把 `browser` 当作**可选**依赖，却写进了 `inject`。`dsh-accounts` 的代填入口就是一例：

```js
export const inject = ['tools', 'credentials', 'browser']
```

cordis 的 `inject` 是**硬门禁**：没有名为 `browser` 的服务，这条 entry 永远停在 pending；而当前 Harness（`packages/boot/app-boot` 的 `assertEntriesActivated`）把"有 entry 未激活"判定为 **boot 失败**：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
dsh-accounts/fill: pending (waiting for service: browser)
```

于是**装上这类插件、但机器上没有 `browser` 服务**的 profile 会直接起不来（上游已在 [issue #2](https://github.com/yangwuan55/dsh-accounts/issues/2) 记录，并在 [PR #3](https://github.com/yangwuan55/dsh-accounts/pull/3) 里改成运行时检测）。

在两者都修好之前，本插件是一条立刻可用的路：**只发布 `browser` 服务，不注册任何工具**。

社区里另一个提供 `browser` 服务的是 [`dsh-builtin-browser`](https://github.com/wqty123/dsh-browser)（npm 上的无 scope 包名，**第三方项目**，不是 DeepSeek 官方；自带 Electron + CDP 与 33 个 `browser_*` 工具）。但如果你已经在用 `browser-skill`（`bsk` + 浏览器扩展，驱动你自己的浏览器），装它会撞车：两者都注册 `browser_session`，而工具注册表对重名直接抛错，`browser-skill` 的六个工具是一次整体注册，会**整组失效**。

| | 驱动 | 工具 | `ctx.browser` 服务 |
|---|---|---|---|
| `browser-skill` | 你的浏览器（扩展 + bsk） | 6 个（懒加载） | ❌ |
| `dsh-builtin-browser` | 自带 Electron | 33 个 | ✅ |
| **本插件** | 你的浏览器（bsk） | **0 个** | ✅ |

因此它可以和 `browser-skill` 共存：会话、Agent Window、登录态都复用同一套 `bsk` daemon。

## 安装

```sh
dsh plugin --profile web add file:/Volumes/Kapp/source/dsh-browser-bsk
```

装完重启 DSH。然后 `dsh-accounts/fill` 就能激活——如果你的 `cordis.patch.yml` 里有为它写的 `disabled: true`，现在可以删掉（有服务了，不会再 pending）。

## 实现的服务面

消费者需要什么就实现什么，没有 stub（未实现的方法直接不存在，调用即报错，不会静默无操作）：

| 方法 | bsk 命令 | 说明 |
|---|---|---|
| `open(label)` | `bsk session start` | 返回 session id；`label` 只记日志（bsk 不按 label 去重） |
| `listTabs(session)` | `bsk tab list --session S` | 归一化为 `{tabId, url, title, active, scope}` |
| `setValue(session, {target, value}, signal)` | `bsk fill --session S --selector X --value V` | 只支持 `by: 'css'`（bsk 只认 CSS 选择器与快照 ref） |
| `click(session, {target}, signal)` | `bsk click --session S --selector X` | 同上 |
| `key(session, {key}, signal)` | `bsk press <KEY> --session S` | 例如 `Enter` |
| `detectChallenge(session, signal)` | `bsk get-html --session S` | 读页面标记匹配验证码特征（reCAPTCHA/hCaptcha/Turnstile/Geetest/滑块…） |
| `close(session)` | `bsk session stop <ID>` | 幂等；会话已消失时静默 |

`dsh-accounts/fill` 里"复用当前会话"的快路径会 `import('dsh-builtin-browser/tool-browser')` 读它的 `internals.sessions`；本插件不提供那个包，所以它每次都会走它自己的**回退路径**（`ctx.browser.open(taskKey)` 自开会话），日志里会有一条 warn。这是已知且预期的行为。

## 配置

`cordis.patch.yml` 的 entry config：

```yaml
- insert:
    - id: browser-bsk
      name: dsh-browser-bsk
      config:
        bskPath: bsk          # bsk CLI；默认从 PATH 解析
        timeoutMs: 120000     # 单次命令超时
        sessionWidth: 1400    # 可选，与 sessionHeight 成对生效
        sessionHeight: 900
```

## 测试

```sh
node --test test/*.test.mjs
```

测试用真实 cordis `Context` 挂载服务（覆盖 `super(ctx, 'browser')` 注册路径），CLI 调用全部走注入的假 runner，**不会启动真实浏览器会话，也不需要 daemon**。

### 真实浏览器端到端（可选，会开一个 Agent Window）

`e2e.mjs` 与 `e2e-challenge.mjs` 走真实 `bsk` daemon：前者在一个本地登录页上跑完 `open → listTabs → detectChallenge → setValue ×2 → click → 校验提交结果 → close`（就是 `dsh-accounts/fill` 的调用序列）；后者是验证码检测的正样本对照。

```sh
mkdir -p /tmp/logintest && cd /tmp/logintest && python3 -m http.server 8123 &
node e2e.mjs            # 期望末尾打印 WELCOME alice
node e2e-challenge.mjs  # 期望打印 markers: g-recaptcha / recaptcha/api.js / captcha / verify you are human
```

需要本目录下有指向 Harness 依赖的 `node_modules`：

```sh
ln -sfn ~/.dsh/profiles/node_modules node_modules   # 仅本地跑测试用，已被 .gitignore 忽略
```

## 已知限制

- 只实现上面那张表；seam 的其他方法（`navigate`/`snapshot`/`execute`/`screenshot`…）没有实现。有消费者需要时再加，而不是现在铺 stub。
- 只支持 CSS 选择器定位（`by: 'css'`，`index: 0`）。
- `detectChallenge` 是标记匹配，不是能力边界：只用于"命中就跳过代填"的保守判断。
- 与 `dsh-builtin-browser` **互斥**（两者都发布 `browser` 服务），同时安装会重复注册服务。
