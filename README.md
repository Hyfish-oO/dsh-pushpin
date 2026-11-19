# Pushpin for DeepSeek Harness

**English** · [中文说明](#中文说明)

Pin the whole DeepSeek Harness window above other windows with a pushpin in the title bar. Version 0.1.0, MIT.

Windows works out of the box. Linux needs `wmctrl` and `xprop` on X11. macOS needs [yabai](https://github.com/koekeishiya/yabai). Where the platform cannot do it, the Host reports why and the button is not rendered.

## Features

- A pushpin button in the title bar, mounted through the `shell.overlay` slot. Host builds without that slot fall back to `conversation.session.header.utilities` (order `100`, after the shipped header buttons).
- One click keeps the DSH main window above other windows; a second click releases it. The button is highlighted in the theme's brand color while the window is pinned.
- The displayed state comes from the window manager, not from the button. After every click the plugin re-reads the real "always on top" state and reports that value back.
- The last state is remembered and re-applied when DSH starts (can be turned off with `restoreOnStart`).
- Backends are per platform: a warm PowerShell server on Windows, `wmctrl`/`xprop` on Linux, `yabai` on macOS. The Windows helper is started on demand and released after an idle timeout.
- Where the platform has no usable backend, the button is not rendered.

## How it works

DSH does not expose the Electron `BrowserWindow` to plugins, so no plugin-side `setAlwaysOnTop` exists. The plugin asks the operating system instead, through a small backend per platform. All of them read the state back after changing it, so the button can only show what the window manager accepted.

**Host half (`index.js`)** registers two exact routes on the DSH web server:

- `GET /dsh-pin/api/state` reads the current state without changing it.
- `POST /dsh-pin/api/toggle` flips it; an optional JSON body may name `"on"`, `"off"` or `"toggle"` as `action`.
- Requests whose `Origin` does not match the DSH web server's origin (when that origin is known) are rejected with `403`.

**Windows** — `scripts/pin-server.ps1` keeps one `powershell.exe` alive:

- Declares `SetWindowPos`, `GetWindowLong` and `GetForegroundWindow` from `user32.dll` once, prints `{"ready":true}`, then reads one action per line on stdin (`get`, `toggle`, `on`, `off`, `quit`) and answers with one compact JSON line on stdout.
- Prefers the DSH window currently in the foreground, falling back to the first process named `DeepSeek Harness` (or whose title contains it).
- Reads `GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST`; to change it calls `SetWindowPos` with `HWND_TOPMOST` / `HWND_NOTOPMOST` and `SWP_NOMOVE | SWP_NOSIZE`, waits 25 ms and reads the flag again.

**Linux (X11)** — `scripts/pin-linux.sh` finds the window in `wmctrl -l`, reads `_NET_WM_STATE_ABOVE` through `xprop`, and changes it with `wmctrl -b add,above` / `remove,above`. Missing tools report `missing-tool`.

**macOS** — `scripts/pin-macos.sh` finds the window through `yabai -m query --windows`, reads its layer, and sets it with `yabai -m window <id> --layer above` / `normal`. Without yabai there is no CLI to change window level, so it reports `missing-tool`.

**Lifecycle (Windows).** The helper starts on first use. One request is in flight at a time; a reply that takes longer than 6 seconds is treated as a timeout, the process is killed and replaced on the next request. After `idleTimeoutMs` without requests the process is released entirely. The Linux and macOS backends are short-lived commands and need no lifecycle.

**Restore.** When the plugin loads, it waits 2.5 seconds and then asks for the window to be pinned if the remembered state was pinned, retrying up to two more times if the window is not up yet. A failure is silent.

## Requirements

- A DSH build that declares `shell.overlay`; otherwise the session header's utilities slot is used.
- No npm runtime dependencies on any platform.
- **Windows:** `powershell.exe` on `PATH` (the default), permitted by system policy and security software.
- **Linux:** X11 with `wmctrl` and `xprop` installed. Wayland is not supported.
- **macOS:** [yabai](https://github.com/koekeishiya/yabai) installed and running.

## Installation

### From the plugin manager

1. Open the DSH plugin manager (or the plugin marketplace, depending on your build).
2. Install the `dsh-pushpin` bundle and enable it.
3. Restart DSH if the pushpin does not appear.

### From a profile

Add the bundle to `%USERPROFILE%\.dsh\profiles\<profile>\package.json`. Both lists must contain it; the snippet below shows only the relevant fields, so keep your existing entries:

```json
{
  "dependencies": {
    "dsh-pushpin": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-pushpin"]
    }
  }
}
```

Then run the profile's install from that directory (`pnpm install`; DSH profiles are pnpm projects) and restart DSH. To develop against a checkout, use a `file:` specifier instead of a version number:

```json
"dsh-pushpin": "file:C:/path/to/dsh-pin-window"
```

## Usage

- Click the pushpin: the window stays above other windows and the button is highlighted. Click again to release it.
- Hover for the current action ("pin" / "unpin"). A failed click shows the reason in the tooltip and in a short bubble beside the pin that fades after two seconds.
- While a request is in flight the glyph dims. The state flips immediately and is reverted if Windows refuses.
- A pin survives a DSH restart only when the last change succeeded and `restoreOnStart` is on.
- The button is absent where the platform has no usable backend (Wayland, macOS without yabai, Linux without `wmctrl`). It is also absent if neither slot exists in the current build (a `[dsh-pin]` warning is logged to the console).

## Configuration

Optional file: `%USERPROFILE%\.dsh\dsh-pin-window.json`. It is not created automatically; the plugin only reads it.

```json
{
  "idleTimeoutMs": 120000,
  "restoreOnStart": true
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `idleTimeoutMs` | number | `120000` | Milliseconds to keep the idle PowerShell process after the last request. `0` keeps it until DSH exits. |
| `restoreOnStart` | boolean | `true` | Re-apply the remembered pin state when DSH starts. |

Rules:

- Read once when the plugin loads. Restart DSH after editing.
- Invalid values fall back to the defaults above: a negative or non-numeric `idleTimeoutMs`, a non-boolean `restoreOnStart`, or an unreadable / malformed file.
- The remembered state lives next to the config in `dsh-pin-window.state.json` and is rewritten after every successful change. Delete it to make the next start ignore the previous state.
- Restore only re-applies a pinned state. If the last state was unpinned, nothing is forced on startup.

## Limitations

- **Exclusive fullscreen covers the window.** Some video players and games take exclusive control of the display and go above a topmost window. This is an OS rule the plugin cannot bypass. Borderless fullscreen (browser F11, most modern games) is unaffected.
- **One window only.** Exactly one window is pinned: the DSH window that is in the foreground at the moment of the press, falling back to the first DSH window when none is. Other DSH windows do not follow.
- **Platform backends are external.** Linux depends on `wmctrl` and `xprop`; macOS depends on yabai. Without them the Host reports `missing-tool` and the button is not rendered.
- **PowerShell must be allowed.** If system policy or security software blocks `powershell.exe`, the button turns red and the tooltip carries the failure reason.
- **First click after idle is slower.** The helper is started on demand, so that press pays for process start and the P/Invoke compile and takes noticeably longer than later clicks.

## Troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| No button | No usable backend, or neither slot is available | Install `wmctrl`/`xprop` on Linux, yabai on macOS; check the console for `[dsh-pin]` |
| Button turns red | PowerShell blocked, window not found, or timeout | Hover the button for the message |
| Pin lost inside an app | That app uses exclusive fullscreen | System limitation; use borderless fullscreen |
| Config change ignored | Config is read at plugin load | Restart DSH |
| Pin not restored after restart | Last change failed, or `restoreOnStart` is off | Check the state file and config |

## Development

```bash
npm test        # exercises both routes against the real window, then unpins it
npm run check   # release gate: version in changelog, placeholder URL, declared files
```

The smoke test really does pin the window for a moment and puts it back at the end, so running it is safe but visible.

## License

MIT. The pushpin glyph is [Lucide](https://lucide.dev)'s `pin` icon, used under the ISC License.

---

# 中文说明

标题栏右上角多一颗钉子，点一下把整个 DeepSeek Harness 窗口钉在其他窗口上面，再点一下取消。Windows 开箱就能用，Linux 需要 `wmctrl` 和 `xprop`，macOS 需要 [yabai](https://github.com/koekeishiya/yabai)；平台做不了的时候按钮不显示。

## 功能

- 钉子挂在 `shell.overlay` 这一层，位置在标题栏右侧。没有这个槽位的 DSH 会退回到会话头部的 `conversation.session.header.utilities`（order `100`，排在自带按钮右侧）。
- 点一下让窗口浮到其他窗口上面，再点一下放回去。置顶时按钮亮起主题的品牌色。
- 显示的状态来自窗口管理器而不是按钮自己记的：每次点击后都重新读一遍真实状态并回报。
- 记住上次状态，DSH 启动时自动恢复（`restoreOnStart` 可以关掉）。
- 后端按平台分：Windows 用常驻 PowerShell，Linux 用 `wmctrl` / `xprop`，macOS 用 yabai。Windows 那个按需启动，闲置超时自动退出。
- 平台没有可用后端时，按钮不渲染。

## 原理

DSH 不把 Electron 的窗口对象开放给插件，插件里没有 `setAlwaysOnTop` 可用。这里的做法是直接问操作系统，每个平台一个小后端，改完都回读一遍，按钮只能显示窗口管理器认可的状态：

- Host 半边（`index.js`）在 DSH 的 web 服务上注册两条路由：`GET /dsh-pin/api/state` 只读状态，`POST /dsh-pin/api/toggle` 切换状态。来源与 DSH web 服务不一致的请求返回 403。
- **Windows**：`scripts/pin-server.ps1` 保持一个常驻 `powershell.exe`，启动时声明一次 `user32.dll` 的 `SetWindowPos`、`GetWindowLong` 和 `GetForegroundWindow`，之后按行接收 `get` / `toggle` / `on` / `off` / `quit`，每次回一行 JSON。优先钉当前在前台的那个 DSH 窗口，没有前台窗口就取第一个进程名或标题带 `DeepSeek Harness` 的。请求串行处理，单次超过 6 秒算超时，进程杀掉、下次重起；闲置超时后整个释放。
- **Linux**：`scripts/pin-linux.sh` 在 `wmctrl -l` 里找窗口，用 `xprop` 读 `_NET_WM_STATE_ABOVE`，用 `wmctrl -b add,above` / `remove,above` 改。工具缺了报 `missing-tool`。
- **macOS**：`scripts/pin-macos.sh` 通过 `yabai -m query --windows` 找窗口、读 layer，用 `yabai -m window <id> --layer above` / `normal` 改。没装 yabai 就报 `missing-tool`。
- 启动恢复：插件加载 2.5 秒后，如果上次是置顶状态就发一次 `on`，窗口还没起来时最多再重试两次，失败不提示。

## 安装

1. 插件管理器（或插件市场）里安装 `dsh-pushpin` 这个 bundle，启用后重启 DSH。
2. 手动：编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，在 `dependencies` 和 `dsh.profile.bundles` 里同时加上 `dsh-pushpin`，在该目录执行 `pnpm install`，重启 DSH。本地开发可以把版本号换成本地路径，例如 `"dsh-pushpin": "file:C:/path/to/dsh-pin-window"`。

## 使用

- 点钉子：窗口置顶，按钮亮起；再点取消。
- 悬停显示当前动作（窗口置顶 / 取消置顶）。失败时除了 tooltip，还会在钉子旁边冒一个两秒后消失的小气泡。
- 请求期间按钮变淡；按钮先按点击切换，Windows 拒绝时再弹回原状态。
- 重启后是否还置顶，取决于上次操作是否成功以及 `restoreOnStart` 是否打开。
- 平台没有可用后端时不显示按钮（Wayland、没装 yabai 的 macOS、缺 `wmctrl` 的 Linux）；当前 DSH 构建两个槽位都没有时也不显示，控制台会有一条 `[dsh-pin]` 警告。

## 配置

可选文件 `%USERPROFILE%\.dsh\dsh-pin-window.json`，插件不会自动创建它，只读取。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `idleTimeoutMs` | 数字 | `120000` | 常驻进程闲置多少毫秒后退出；`0` 表示不自动退出。 |
| `restoreOnStart` | 布尔 | `true` | DSH 启动后是否恢复上次的置顶状态。 |

- 配置在插件加载时读取一次，改完需要重启 DSH。
- 非法值回落到上面的默认值（负数或非数字的 `idleTimeoutMs`、非布尔的 `restoreOnStart`、文件读不出来或格式不对）。
- 上次状态存在同目录的 `dsh-pin-window.state.json`，每次操作成功后重写。删掉它，下次启动就不会恢复。
- 恢复只做「置顶」，上次是取消置顶状态时启动不会强行改窗口。

## 限制

- **独占全屏的程序会盖住置顶窗口**（部分播放器、游戏）。这是系统机制，插件绕不过去；浏览器 F11 那种无边框全屏不受影响。
- **只钉一个窗口**。钉的是点击那一刻在前台的那个 DSH 窗口，找不到前台窗口时退回到第一个。DSH 开多个窗口时，其他窗口不跟着置顶。
- **平台的置顶能力来自外部工具**。Linux 依赖 `wmctrl` 和 `xprop`，macOS 依赖 yabai；缺了就报 `missing-tool`，按钮不渲染。
- **Windows 上需要允许运行 PowerShell**。系统策略或安全软件拦住 `powershell.exe` 时，按钮变红，悬停能看到失败原因。
- **Windows 上闲置后第一次点击慢一些**，要先启动 PowerShell 并编译 P/Invoke，之后几次点击就快了。

## 开发

```bash
npm test        # 对着真窗口跑一遍两条路由，跑完会把窗口还原成不置顶
npm run check   # 发布前检查：版本号在不在 CHANGELOG、仓库地址是不是占位、清单里的文件齐不齐
```

冒烟测试会真的把窗口置顶一下再放回去，能看见，但不会留下改动。

## 许可证

MIT。图钉图形来自 [Lucide](https://lucide.dev) 的 `pin` 图标，ISC 许可。
