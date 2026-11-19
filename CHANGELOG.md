# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-19

First release.

### Added

- A pushpin in the session header's right-aligned utilities (`conversation.session.header.utilities`, order `100`) that sets the whole DeepSeek Harness window topmost.
- State read back from Windows after every change, so the button only reports what the operating system accepted.
- A warm PowerShell helper (`scripts/pin-server.ps1`) that calls `SetWindowPos` / `GetWindowLong`, started on demand.
- Idle release of that helper, so an installed but unused plugin holds no process.
- Remembered pin state, re-applied when DSH starts, with `restoreOnStart` to turn it off.
- Foreground-aware window lookup: the DSH window the user is looking at wins, which keeps multi-monitor setups honest.
- Human-readable failure messages for a blocked PowerShell, a missing window, and a timeout.
- A short error bubble next to the pin in addition to the tooltip.
- English and Chinese UI text and plugin metadata.

### Known limitations

- Windows only. The button is not rendered elsewhere.
- Exclusive fullscreen applications cover a topmost window; this cannot be bypassed.
- Only the main window is pinned; additional DSH windows do not follow.
- The first press after the helper has been released is slower, because PowerShell has to start and compile the P/Invoke type.
