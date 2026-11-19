# 窗口置顶

标题栏右上角多一颗钉子，点一下把整个 DeepSeek Harness 窗口钉在其他窗口上面，再点一下取消。亮起表示已置顶。

## 功能

- 点击切换置顶。按钮显示的状态跟着窗口管理器走：每次点击后都会回读真实状态，不是按钮自己记的。
- 记住上次状态，DSH 重启后自动恢复（可在配置里关掉）。
- 失败时按钮变红，悬停能看到原因，钉子旁边还会冒一个两秒的小气泡。
- 后端按平台分：Windows 用常驻 PowerShell，Linux 用 `wmctrl` / `xprop`，macOS 用 yabai。

## 原理

DSH 没有把 Electron 的窗口对象开放给插件，所以插件走操作系统自己的接口：Windows 用 `user32.dll` 的 `SetWindowPos` / `GetWindowLong`，Linux 用 `wmctrl` 改 `_NET_WM_STATE_ABOVE`、`xprop` 回读，macOS 用 yabai 改窗口 layer。改完都重新读一遍，按钮只显示窗口管理器认可的值。

## 配置

配置文件 `~/.dsh/dsh-pin-window.json`，不存在时全部使用默认值：

- `idleTimeoutMs`：数字，默认 `120000`。Windows 上常驻进程闲置多久后退出，`0` 表示不自动退出。
- `restoreOnStart`：布尔，默认 `true`。重启 DSH 后是否恢复上次的置顶状态。

配置在插件加载时读取，改完需要重启 DSH。

## 平台依赖

- **Windows**：`powershell.exe` 在 `PATH` 里，且没被系统策略或安全软件拦掉。
- **Linux**：X11 下有 `wmctrl` 和 `xprop`。Wayland 不支持。
- **macOS**：装了 [yabai](https://github.com/koekeishiya/yabai)。

缺依赖时按钮不渲染，Host 返回 `missing-tool`。

## 限制

- 独占全屏的程序（部分播放器、游戏）会盖住置顶窗口，这是系统机制，绕不过去。浏览器 F11 那种无边框全屏不受影响。
- 只钉一个窗口。钉的是点击那一刻在前台的那个 DSH 窗口，找不到时取第一个；其他 DSH 窗口不跟着置顶。
- Windows 上闲置后第一次点击要先起 PowerShell，会比平时慢几百毫秒。
