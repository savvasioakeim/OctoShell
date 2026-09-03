//! Tell child processes what timezone this machine is in.
//!
//! Sounds like housekeeping; it is actually the fix for terminal windows
//! flashing across the screen.
//!
//! `gh` shells out to `tzutil.exe` to learn the local timezone whenever `TZ` is
//! unset. Measured: ten `gh pr view` runs spawned it fourteen times with no TZ,
//! and zero times with TZ set. Usually tzutil inherits our console and nobody
//! notices — but `gh` sometimes starts a second `gh` that has no console at all,
//! and then tzutil allocates its own. On a machine where Windows Terminal is the
//! default terminal application, allocating a console opens a real terminal
//! window: a full-screen flash over whatever you were doing, for a fraction of a
//! second, at 3am.
//!
//! No flag on OUR processes can prevent that, because the process that allocates
//! is a grandchild we never spawn. Removing the reason it runs at all does.
//!
//! Setting TZ once on ourselves covers every child we will ever spawn — agents,
//! shells, the PR poll — instead of every spawn site remembering to.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The env var name, so the two places that care cannot disagree about it.
pub const TZ: &str = "TZ";

/// Is this plausibly an IANA zone id we can safely hand to `TZ`?
///
/// Deliberately strict. A wrong value here silently shifts every timestamp that
/// every child process prints, which is far worse than the flashing we are
/// fixing — so anything unexpected means "leave TZ alone".
pub fn looks_iana(s: &str) -> bool {
    let s = s.trim();
    // Region/City, occasionally Region/Sub/City. A Windows id like
    // "GTB Standard Time" has spaces and no slash, and must never get through.
    if !s.contains('/') || s.len() > 64 || s.is_empty() {
        return false;
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
}

/// Ask Windows for the IANA name of the local timezone.
///
/// .NET 6+ knows the Windows→IANA mapping, so PowerShell 7 can answer it and we
/// avoid carrying a 400-row CLDR table. Windows PowerShell 5.1 does NOT have
/// `TryConvertWindowsIdToIanaId`, so pwsh is required and its absence simply
/// means we skip this.
#[cfg(windows)]
fn resolve_iana() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script = "$i=$null; \
        if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId([System.TimeZoneInfo]::Local.Id, [ref]$i)) { $i }";
    let out = Command::new("pwsh.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    looks_iana(&id).then_some(id)
}

#[cfg(not(windows))]
fn resolve_iana() -> Option<String> {
    None // every other platform already has a working TZ story
}

/// Where the resolved zone is remembered between runs.
///
/// Resolving costs ~700ms because it starts PowerShell, and paying that on every
/// launch to learn something that changes maybe twice a year would be a poor
/// trade. The cache is read instantly at startup and refreshed in the
/// background, so a zone change is picked up on the next launch.
fn cache_path(dir: &std::path::Path) -> PathBuf {
    dir.join("timezone.txt")
}

/// Set `TZ` for this process (and therefore every child).
///
/// Returns the value in effect, when we set one. Never overrides an existing TZ:
/// if the user set one, they meant it.
///
/// `dir` is the app config directory; pass None to skip the cache entirely
/// (tests, and any caller without an app handle).
pub fn apply_with_cache(dir: Option<PathBuf>) -> Option<&'static str> {
    static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
    let v = RESOLVED.get_or_init(|| {
        if std::env::var_os(TZ).is_some() {
            return None; // the user's choice wins
        }

        let cached = dir
            .as_deref()
            .and_then(|d| std::fs::read_to_string(cache_path(d)).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| looks_iana(s));

        if let Some(id) = &cached {
            std::env::set_var(TZ, id);
        }

        // Refresh off the startup path either way: with no cache this is what
        // sets TZ at all (a second or so in, on first ever launch); with one it
        // just keeps the file honest.
        let had_cache = cached.is_some();
        std::thread::spawn(move || {
            let Some(id) = resolve_iana() else { return };
            if !had_cache {
                std::env::set_var(TZ, &id);
            }
            if let Some(d) = dir {
                let _ = std::fs::create_dir_all(&d);
                let _ = std::fs::write(cache_path(&d), &id);
            }
        });

        cached
    });
    v.as_deref()
}

#[cfg(test)]
mod tests {
    use super::looks_iana;

    #[test]
    fn accepts_real_zone_ids() {
        for s in [
            "Europe/Bucharest",
            "Europe/Athens",
            "America/New_York",
            "America/Argentina/Buenos_Aires",
            "Etc/UTC",
            "Etc/GMT+3",
        ] {
            assert!(looks_iana(s), "should accept {s}");
        }
    }

    #[test]
    fn rejects_anything_that_is_not_one() {
        for s in [
            "",                       // pwsh printed nothing
            "GTB Standard Time",      // the Windows id, unconverted
            "UTC",                    // no region: not what we asked for
            "Europe/",                // truncated
            "/Bucharest",             // truncated the other way
            "Europe//Bucharest",      // empty component
            "A/B/C/D",                // too deep to be real
            "Europe/Bucharest; rm -rf /", // anything with punctuation
            "Europe/Bucharest\nEurope/Kyiv", // two lines of output
        ] {
            assert!(!looks_iana(s), "should reject {s:?}");
        }
    }

    #[test]
    fn rejects_absurd_length() {
        assert!(!looks_iana(&format!("Europe/{}", "a".repeat(80))));
    }
}
