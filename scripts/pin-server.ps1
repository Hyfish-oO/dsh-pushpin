# Long-lived pin server. The Host keeps this process warm and writes one
# action per line on stdin; each line gets one compact JSON answer on stdout.
# Spawning PowerShell and compiling the P/Invoke type costs most of a second,
# so paying that once is what makes the button feel instant afterwards.
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshPinWin {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$GWL_EXSTYLE = -20
$WS_EX_TOPMOST = 0x0008
$FLAGS = $SWP_NOMOVE -bor $SWP_NOSIZE

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Test-DshProcess($proc) {
  if ($null -eq $proc) { return $false }
  if ($proc.MainWindowHandle -eq 0) { return $false }
  return ($proc.ProcessName -eq 'DeepSeek Harness') -or ($proc.MainWindowTitle -like '*DeepSeek Harness*')
}

# The window the user is actually looking at wins, so a multi-monitor setup
# pins the window in front of them rather than whichever process came first.
function Find-Window {
  $foreground = [DshPinWin]::GetForegroundWindow()
  if ($foreground -ne [IntPtr]::Zero) {
    $foregroundPid = 0
    [void][DshPinWin]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    if ($foregroundPid -ne 0) {
      $candidate = Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue
      if (Test-DshProcess $candidate) { return $candidate }
    }
  }

  return Get-Process -ErrorAction SilentlyContinue |
    Where-Object { Test-DshProcess $_ } |
    Select-Object -First 1
}

Write-Line '{"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $action = $line.Trim().ToLowerInvariant()
  if ($action -eq '' ) { continue }
  if ($action -eq 'quit') { break }

  try {
    $proc = Find-Window
    if (-not $proc) {
      Write-Line '{"ok":false,"error":"no-window"}'
      continue
    }

    $handle = $proc.MainWindowHandle
    $isTop = ([DshPinWin]::GetWindowLong($handle, $GWL_EXSTYLE) -band $WS_EX_TOPMOST) -ne 0

    if ($action -ne 'get') {
      $want = if ($action -eq 'toggle') { -not $isTop } else { $action -eq 'on' }
      $insertAfter = if ($want) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
      [void][DshPinWin]::SetWindowPos($handle, $insertAfter, 0, 0, 0, 0, $FLAGS)
      Start-Sleep -Milliseconds 25
      $isTop = ([DshPinWin]::GetWindowLong($handle, $GWL_EXSTYLE) -band $WS_EX_TOPMOST) -ne 0
    }

    $flag = if ($isTop) { 'true' } else { 'false' }
    Write-Line ('{"ok":true,"topmost":' + $flag + ',"hwnd":"' + $handle + '"}')
  }
  catch {
    Write-Line '{"ok":false,"error":"powershell"}'
  }
}
