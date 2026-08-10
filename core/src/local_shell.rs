//! Local-shell resolution shared between opening an interactive local
//! terminal (`commands::terminal::open_local_terminal`) and the adaptive
//! snippet engine's local-terminal support
//! (`commands::adaptive::compose_adaptive_for_local`) — both need the exact
//! same "which shell does this tab actually run" answer.

/// The shell a local terminal opens when none is explicitly chosen.
pub fn default_local_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Resolves `shell` (a local-terminal tab's configured shell, possibly
/// unset) to the shell that tab actually runs.
pub fn resolve_local_shell(shell: Option<&str>) -> String {
    shell.filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(default_local_shell)
}

/// Whether `shell` is a native Windows shell (PowerShell/cmd) — no POSIX
/// environment underneath, so the adaptive engine's `sh`-based facts probe
/// (`facts::probe_local`) would never produce anything useful there. The
/// platform for a shell like this is instead known instantly (it's whatever
/// OS Guiterm itself runs on) — no probing needed at all.
pub fn is_windows_native_shell(shell: &str) -> bool {
    let name = shell.rsplit(['\\', '/']).next().unwrap_or(shell).to_lowercase();
    matches!(name.as_str(), "cmd.exe" | "cmd" | "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh")
}

/// Builds a one-shot, non-interactive invocation of `shell` running
/// `script` — never the live interactive local-terminal pty, which already
/// shows a prompt (injecting output there would corrupt the display). Each
/// shell family has its own way to run a single command: `wsl.exe` needs
/// `-e sh -c` (passed as literal arguments — `wsl.exe` alone doesn't
/// understand `-c`), `cmd.exe` needs `/c`, PowerShell needs `-Command`, and
/// every other shell (a real POSIX shell) understands `-c`.
pub(crate) fn one_shot_command(shell: &str, script: &str) -> std::process::Command {
    let name = shell.rsplit(['\\', '/']).next().unwrap_or(shell).to_lowercase();
    let mut cmd = std::process::Command::new(shell);
    match name.as_str() {
        "wsl.exe" | "wsl" => {
            cmd.args(["-e", "sh", "-c", script]);
        }
        "cmd.exe" | "cmd" => {
            cmd.args(["/c", script]);
        }
        "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh" => {
            cmd.args(["-Command", script]);
        }
        _ => {
            cmd.args(["-c", script]);
        }
    }
    // No console window on Windows.
    //
    // This was the one spawn site in the repo without it, and the omission was
    // visible: every local fleet run, facts probe and network diagnostic
    // flashed a PowerShell window on screen — several per run, since each
    // target is its own process. `proxy_command`, `aws_sso`, `ssm_tunnel`,
    // `aws_inventory` and `cloud_cli` all set it; this is the choke point for
    // "Terminal local", so setting it here covers every caller at once.
    //
    // The *interactive* local terminal is unaffected: it goes through a pty
    // and is drawn by xterm, never by a console of its own.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs `script` as a one-shot, non-interactive process through `shell`
/// (see [`one_shot_command`]), capturing full stdout/stderr/exit code — the
/// fleet executor's "Terminal local" target. Blocking (spawns a real OS
/// process and waits) — callers on the async side must wrap this in
/// `spawn_blocking`.
pub fn run_capture(shell: &str, script: &str) -> std::io::Result<LocalRunOutcome> {
    let output = one_shot_command(shell, script).output()?;
    Ok(LocalRunOutcome {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalRunOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_to_default_when_unset() {
        assert_eq!(resolve_local_shell(None), default_local_shell());
        assert_eq!(resolve_local_shell(Some("")), default_local_shell());
    }

    #[test]
    fn resolve_keeps_an_explicit_shell() {
        assert_eq!(resolve_local_shell(Some("/bin/zsh")), "/bin/zsh");
    }

    #[test]
    fn recognizes_windows_native_shells_by_basename_case_insensitively() {
        assert!(is_windows_native_shell("powershell.exe"));
        assert!(is_windows_native_shell("PowerShell.EXE"));
        assert!(is_windows_native_shell("cmd.exe"));
        assert!(is_windows_native_shell(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"));
        assert!(is_windows_native_shell("pwsh.exe"));
    }

    #[test]
    fn does_not_flag_posix_shells_or_wsl() {
        assert!(!is_windows_native_shell("/bin/bash"));
        assert!(!is_windows_native_shell("/bin/sh"));
        assert!(!is_windows_native_shell(r"C:\Windows\System32\wsl.exe"));
        assert!(!is_windows_native_shell(r"C:\Program Files\Git\bin\bash.exe"));
    }

    // A real local process — no SSH/RDP/Docker daemon needed.
    #[cfg(not(windows))]
    #[test]
    fn run_capture_runs_a_real_command_via_a_real_shell() {
        let outcome = run_capture("sh", "echo hello; exit 3").expect("sh should spawn");
        assert_eq!(outcome.exit_code, Some(3));
        assert_eq!(outcome.stdout.trim(), "hello");
    }

    #[test]
    fn run_capture_returns_an_error_for_a_shell_that_cannot_be_spawned() {
        assert!(run_capture("/definitely/not/a/real/shell/binary", "echo hi").is_err());
    }
}
