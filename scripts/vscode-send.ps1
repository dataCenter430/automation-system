<#
  Synthetic input into the VS Code window.

  The single most important thing this script does is make sure the RIGHT window has focus
  before any keystroke is sent. SendKeys goes wherever focus happens to be - so if focus is
  wrong we would paste a 52 KB prompt into whatever the user was typing in. Every path here
  therefore verifies focus and FAILS rather than sending blind.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("focus-window", "send-chord", "type", "paste", "enter", "set-clipboard", "check-window", "close-window", "check-desktop")]
  [string]$Action,

  [string]$Window = "Visual Studio Code",
  [string]$Chord = "",
  [string]$File = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# Windows deliberately refuses SetForegroundWindow to a process that is not already in the
# foreground (focus-stealing prevention). A plain call therefore fails silently from a
# background worker - which is exactly what happened the first time this ran.
#
# The sanctioned way around it is to attach our input queue to the CURRENT foreground
# window's thread: while attached, Windows considers us part of the same input context and
# allows the focus change. The ALT tap is the other half of the folklore - pressing and
# releasing ALT releases the foreground lock that Explorer holds.
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  // Electron hosts MANY windows in ONE process, so Process.MainWindowHandle only ever
  // reveals one of them - a second VS Code window is invisible to Get-Process. We must
  // enumerate top-level WINDOWS instead.
  //
  // And the enumeration lives here in C#, not in PowerShell, on purpose: a PowerShell
  // scriptblock cast to a delegate does NOT capture the enclosing scope in Windows
  // PowerShell 5.1. The callback ran, but its $found list and $TitleMatch were both null
  // inside, so every window silently failed to match. Doing it in C# sidesteps that whole
  // class of bug.
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

  /** Every visible VS Code window whose title contains `titleMatch`, as "hwnd|title" lines. */
  public static string[] FindVsCodeWindows(string titleMatch) {
    var hits = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      // Deliberately NOT filtering on IsWindowVisible.
      //
      // A window launched from a process spawned with windowsHide/SW_HIDE is real and
      // focusable but invisible, and VS Code still counts the folder as open - so skipping
      // invisible windows meant we reported "not open" forever while the window sat there.
      // Find it, then un-hide it (ForceForeground calls SW_SHOW).

      // Electron/Chromium top-level windows all use this class.
      var cls = new System.Text.StringBuilder(256);
      GetClassNameW(h, cls, 256);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;

      // Identify VS Code by its OWNING PROCESS, not by its title.
      //
      // With the modern "command centre" title bar, a VS Code window's OS title is just the
      // folder name - "Visual Studio Code" does not appear in it at all. Matching on that
      // string meant we never found the task window, so the prompt was never sent. The
      // process name is the thing that is actually stable. (The class check above alone
      // isn't enough: Chrome uses the same window class.)
      uint pid;
      GetWindowThreadProcessIdOut(h, out pid);
      try {
        var proc = System.Diagnostics.Process.GetProcessById((int)pid);
        if (!proc.ProcessName.Equals("Code", StringComparison.OrdinalIgnoreCase)) return true;
      } catch { return true; } // process vanished mid-enumeration

      var sb = new System.Text.StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string title = sb.ToString();

      // A titleless Chrome_WidgetWin_1 is one of Electron's internal helper windows.
      if (title.Length > 0 && title.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) >= 0) {
        hits.Add(h.ToInt64() + "|" + (IsWindowVisible(h) ? "visible" : "hidden") + "|" + title);
      }
      return true;
    }, IntPtr.Zero);
    return hits.ToArray();
  }

  /**
   * Put text on the clipboard, with retries.
   *
   * The clipboard is a single global resource any process can hold open, and remote-desktop
   * tools (AnyDesk, RustDesk - both running on this machine) grab it constantly to sync it.
   * PowerShell's Set-Clipboard makes ONE attempt and dies with "Requested Clipboard
   * operation did not succeed". SetDataObject's retry overload exists for exactly this.
   *
   * It needs an STA thread, and it must be created HERE: a PowerShell scriptblock invoked
   * from a bare .NET thread has no runspace and silently does nothing at all.
   *
   * Returns null on success, or the error message.
   */
  public static string SetClipboard(string text) {
    string err = null;
    var t = new System.Threading.Thread(delegate() {
      try { System.Windows.Forms.Clipboard.SetDataObject(text, true, 10, 150); }
      catch (Exception e) { err = e.Message; }
    });
    t.SetApartmentState(System.Threading.ApartmentState.STA);
    t.Start();
    if (!t.Join(20000)) return "timed out after 20s - another process is holding the clipboard open";
    return err;
  }

  public static string GetClipboard() {
    string val = null;
    var t = new System.Threading.Thread(delegate() {
      try { val = System.Windows.Forms.Clipboard.GetText(); } catch { val = null; }
    });
    t.SetApartmentState(System.Threading.ApartmentState.STA);
    t.Start();
    t.Join(10000);
    return val;
  }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

  // NOTE the types. These take DWORD (32-bit), not IntPtr. Declaring them as IntPtr on x64
  // marshals 64-bit values into 32-bit slots and the calls silently do nothing - which is
  // exactly how the first version of this script failed.
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] private static extern uint GetWindowThreadProcessIdOut(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

  const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
  const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;

  public static bool ForceForeground(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;

    // Windows keeps a "foreground lock timeout" that blocks background processes from
    // stealing focus. Setting it to 0 for the duration is the documented way to opt out.
    IntPtr zero = IntPtr.Zero;
    SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, zero, 0);

    // Tapping ALT releases the lock the active app holds.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);        // ALT down
    keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);   // ALT up (KEYEVENTF_KEYUP)

    IntPtr fg = GetForegroundWindow();
    uint fgThread  = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint ourThread = GetCurrentThreadId();

    bool attached = false;
    if (fgThread != 0 && fgThread != ourThread) {
      // While our input queue is attached to the foreground window's thread, Windows treats
      // us as part of the same input context and permits the focus change.
      attached = AttachThreadInput(ourThread, fgThread, true);
    }
    try {
      if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
      ShowWindow(hWnd, 5);                     // SW_SHOW
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
      if (GetForegroundWindow() != hWnd) SwitchToThisWindow(hWnd, true);
    } finally {
      if (attached) AttachThreadInput(ourThread, fgThread, false);
    }
    return GetForegroundWindow() == hWnd;
  }
}
"@

# A locked workstation switches the interactive desktop to the secure Winlogon desktop.
# While that is up, NOTHING can focus an application window or deliver a keystroke to one -
# no amount of AttachThreadInput or SetForegroundWindow will help. So detect it and say so,
# instead of surfacing a baffling "could not focus the window" four layers up.
function Test-DesktopLocked {
  if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { return $true }
  $sb = New-Object System.Text.StringBuilder 300
  [void][Win32]::GetWindowTextW([Win32]::GetForegroundWindow(), $sb, 300)
  return ($sb.ToString() -like "*Lock Screen*")
}

function Assert-DesktopUsable {
  if (Test-DesktopLocked) {
    throw "The Windows desktop is LOCKED. The visual build drives the real VS Code window, so it needs an unlocked, signed-in session. Unlock the machine and leave it unlocked (and disable the screensaver lock / RDP disconnect lock) while builds run."
  }
}

# Find a VS Code window by title, by enumerating TOP-LEVEL WINDOWS - not processes.
#
# This matters far more than it looks. VS Code is Electron: ONE process hosts MANY windows,
# and .NET's Process.MainWindowHandle/MainWindowTitle reports only a SINGLE window per
# process - whichever Windows considers "main". So a second VS Code window is entirely
# invisible to Get-Process, and the title you do get flips between windows as focus moves.
# Process enumeration found our workspace window once and then silently stopped seeing it,
# which is exactly how this failed.
#
# EnumWindows sees every window, so ask the desktop directly.
function Get-VsCodeWindow {
  param([string]$TitleMatch)

  $hits = [Win32]::FindVsCodeWindows($TitleMatch)
  if (-not $hits -or $hits.Count -eq 0) { return $null }

  $parts = $hits[0].Split('|', 3)
  return [pscustomobject]@{
    Handle  = [IntPtr][int64]$parts[0]
    Visible = ($parts[1] -eq 'visible')
    Title   = $parts[2]
  }
}

function Focus-Window {
  param([string]$TitleMatch)
  Assert-DesktopUsable
  $w = Get-VsCodeWindow -TitleMatch $TitleMatch
  if (-not $w) { throw "No VS Code window whose title contains '$TitleMatch'. Is it open yet?" }

  $h = $w.Handle

  # Already foreground? Do nothing at all.
  #
  # This is not just an optimisation. ForceForeground taps ALT (see below) and ALT OPENS THE
  # VS CODE MENU BAR, which then swallows every keystroke that follows. Calling it again on
  # an already-focused window would re-open the menu right before we type - which is exactly
  # how the prompt ended up going nowhere. Every action here calls Focus-Window, so this
  # early return is what keeps focus/chord/type composable.
  if ([Win32]::GetForegroundWindow() -eq $h) { return $w }

  # A hidden window (SW_HIDE, inherited from a windowsHide launch) is focusable but you
  # cannot see it - which defeats the whole point of a "visual" build. Bring it back.
  if (-not $w.Visible) {
    [void][Win32]::ShowWindow($h, 5)   # SW_SHOW
    [void][Win32]::ShowWindow($h, 9)   # SW_RESTORE
    Start-Sleep -Milliseconds 500
  }

  # Windows intermittently refuses the foreground change while another window is active -
  # it is a race, not a hard failure, and it succeeds on a later attempt. Observed live:
  # five attempts failed, then the very next call worked. So retry patiently, with backoff.
  for ($i = 0; $i -lt 12; $i++) {
    if ([Win32]::ForceForeground($h)) {
      Start-Sleep -Milliseconds 250
      if ([Win32]::GetForegroundWindow() -eq $h) {
        # ForceForeground taps ALT to release Windows' foreground lock, and in VS Code a bare
        # ALT tap OPENS THE MENU BAR. The menu then captures everything we type next. ESC
        # closes it. (Verified from a screenshot: the File menu was hanging open and had eaten
        # the entire prompt.)
        [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
        Start-Sleep -Milliseconds 250
        return $w
      }
    }
    Start-Sleep -Milliseconds (300 + ($i * 150))
  }

  # We verify rather than assume: a silent focus failure is how a 52 KB prompt ends up typed
  # into whatever the user happened to be looking at.
  throw "Could not bring the VS Code window '$($w.Title)' to the foreground after 12 attempts. Refusing to send keystrokes to whatever else has focus."
}

switch ($Action) {

  "check-desktop" {
    if (Test-DesktopLocked) { Write-Output "LOCKED" } else { Write-Output "OK" }
  }

  "check-window" {
    # Report VISIBILITY, not just existence. A window created by a process spawned with
    # SW_HIDE is a real, focusable HWND that never renders - SetForegroundWindow reports
    # success on it while the user stares at File Explorer, and the Claude webview inside it
    # never gets the keystrokes. The caller has to be able to tell the two apart.
    $w = Get-VsCodeWindow -TitleMatch $Window
    if (-not $w) { Write-Output "NONE"; break }
    Write-Output "OK|$(if ($w.Visible) { 'visible' } else { 'hidden' })|$($w.Title)"
  }

  "close-window" {
    # Dispose of a hidden window. ShowWindow cannot rescue one: Electron tracks its own show
    # state and puts it straight back. But while it exists, VS Code counts the folder as open
    # and will not reopen it - so the only way out is to close it and start again.
    $w = Get-VsCodeWindow -TitleMatch $Window
    if (-not $w) { Write-Output "NONE"; break }
    $res = [IntPtr]::Zero
    [void][Win32]::SendMessageTimeout($w.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$res)  # WM_CLOSE
    Start-Sleep -Milliseconds 1500
    Write-Output "OK|closed"
  }

  "focus-window" {
    $w = Focus-Window -TitleMatch $Window
    Write-Output "OK|$($w.Title)"
  }

  "set-clipboard" {
    if (-not $File) { throw "set-clipboard requires -File. Large prompts must not travel as command-line arguments." }
    if (-not (Test-Path -LiteralPath $File)) { throw "No such file: $File" }
    $text = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)

    $err = [Win32]::SetClipboard($text)
    if ($err) { throw "Clipboard set failed: $err" }

    # Verify. Pasting a STALE clipboard into a Claude session would be worse than failing -
    # we would hand it the previous task's prompt and never know.
    #
    # Compare on normalized line endings: the clipboard stores CRLF while our prompt files
    # are LF, so a raw length comparison mismatches by exactly the number of lines.
    $back = [Win32]::GetClipboard()
    $a = $text -replace "`r`n", "`n"
    $b = if ($null -eq $back) { "" } else { $back -replace "`r`n", "`n" }
    if ($a -ne $b) {
      throw "Clipboard did not take: wrote $($a.Length) chars, read back $($b.Length)."
    }
    Write-Output "OK|$($a.Length)"
  }

  "type" {
    # Type literal text. Only viable because the message is one short line - the prompt
    # itself lives in a file in the workspace, precisely so we never have to synthesise
    # thousands of keystrokes or depend on the (contended) clipboard.
    if (-not $Chord) { throw "type requires -Chord (the text, already SendKeys-escaped)." }
    Focus-Window -TitleMatch $Window | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait($Chord)
    Start-Sleep -Milliseconds 400
    Write-Output "OK|typed $($Chord.Length) chars"
  }

  "send-chord" {
    if (-not $Chord) { throw "send-chord requires -Chord (SendKeys syntax, e.g. '^%+{F10}')." }
    Focus-Window -TitleMatch $Window | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait($Chord)
    Start-Sleep -Milliseconds 400
    Write-Output "OK|$Chord"
  }

  "paste" {
    Focus-Window -TitleMatch $Window | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    # A big paste into a webview takes a moment to land; pressing Enter too early submits
    # a half-pasted prompt.
    Start-Sleep -Milliseconds 1200
    Write-Output "OK|paste"
  }

  "enter" {
    Focus-Window -TitleMatch $Window | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 300
    Write-Output "OK|enter"
  }
}
