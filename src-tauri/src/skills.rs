//! Which Agent Skills an agent will actually see.
//!
//! "The agent can't see my skills" is nearly always a question about paths, not
//! about the model: a skill is a directory holding a `SKILL.md`, and Claude Code
//! looks for those directories in three unrelated places --
//!
//!   * the working directory (`.claude/skills`, plus the `.agents` / `.cursor`
//!     variants) -- which for a dispatched agent is the WORKTREE, not the repo
//!     you opened, so an untracked skill in the main checkout is simply absent;
//!   * the config dir (`<CLAUDE_CONFIG_DIR>/skills`), which our profiles swap
//!     out from under you;
//!   * installed plugins, each carrying its own `skills` folder.
//!
//! Listing all three with their source attached turns that guess into an answer.
//! Skills bundled inside the CLI binary are not on disk and so cannot appear
//! here; they are always available.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// One skill found on disk.
#[derive(Serialize)]
pub struct SkillInfo {
    /// Frontmatter `name:`, falling back to the directory name.
    pub name: String,
    /// Frontmatter `description:` — what decides whether the model reaches for it.
    pub description: String,
    /// "project" | "personal" | "plugin" — where it came from.
    pub source: String,
    /// The `SKILL.md` itself, so the UI can say exactly which file it read.
    pub path: String,
}

/// The user's Claude home: the profile's config dir, else `~/.claude`.
fn claude_home(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir.filter(|s| !s.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => crate::ai::home_dir().map(|h| h.join(".claude")),
    }
}

/// Read `name` and `description` out of a `SKILL.md` YAML frontmatter block.
///
/// Deliberately a line scanner rather than a YAML parser: we only need two
/// scalar keys, and a skill whose frontmatter we cannot parse should still be
/// listed (under its directory name) rather than vanish from a page whose whole
/// job is to tell you what exists.
fn read_frontmatter(md: &Path) -> (Option<String>, String) {
    let text = match std::fs::read_to_string(md) {
        Ok(t) => t,
        Err(_) => return (None, String::new()),
    };
    let mut name = None;
    let mut desc = String::new();
    let mut in_fm = false;
    for line in text.lines() {
        let t = line.trim_end();
        if t.trim() == "---" {
            if in_fm {
                break;
            }
            in_fm = true;
            continue;
        }
        if !in_fm {
            break; // no frontmatter at all
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(unquote(v));
        } else if let Some(v) = t.strip_prefix("description:") {
            desc = unquote(v);
        }
    }
    (name.filter(|s| !s.is_empty()), desc)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let v = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(v);
    let v = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).unwrap_or(v);
    v.trim().to_string()
}

/// Collect every `<dir>/*/SKILL.md` under one skills directory.
fn scan(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // absent is the normal case, not an error
    };
    for e in entries.flatten() {
        let md = e.path().join("SKILL.md");
        if !md.is_file() {
            continue;
        }
        let (fm_name, description) = read_frontmatter(&md);
        let name = fm_name.unwrap_or_else(|| e.file_name().to_string_lossy().to_string());
        out.push(SkillInfo {
            name,
            description,
            source: source.to_string(),
            path: md.to_string_lossy().to_string(),
        });
    }
}

/// Every skill directory an installed plugin brings with it.
fn scan_plugins(home: &Path, out: &mut Vec<SkillInfo>) {
    // <home>/plugins/cache/<marketplace>/<plugin>/<version>/skills
    let cache = home.join("plugins").join("cache");
    let markets = match std::fs::read_dir(&cache) {
        Ok(e) => e,
        Err(_) => return,
    };
    for m in markets.flatten() {
        let plugins = match std::fs::read_dir(m.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for p in plugins.flatten() {
            let versions = match std::fs::read_dir(p.path()) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for v in versions.flatten() {
                scan(&v.path().join("skills"), "plugin", out);
            }
        }
    }
}

/// List the skills visible to an agent running in `cwd` under `config_dir`.
///
/// Both arguments are the ones we would really pass to the CLI, so the answer is
/// what that agent would see -- point it at a worktree and you learn whether the
/// worktree has the skill, which is the question that actually gets asked.
#[tauri::command]
pub fn list_skills(config_dir: Option<String>, cwd: Option<String>) -> Vec<SkillInfo> {
    let mut out = Vec::new();

    if let Some(c) = cwd.as_deref().filter(|s| !s.is_empty()) {
        let root = Path::new(c);
        for d in [".claude", ".agents", ".cursor"] {
            scan(&root.join(d).join("skills"), "project", &mut out);
        }
    }
    if let Some(home) = claude_home(config_dir.as_deref()) {
        scan(&home.join("skills"), "personal", &mut out);
        scan_plugins(&home, &mut out);
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty directory to build a fake project in.
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("octo-skills-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_skill(cwd: &Path, dir: &str, body: &str) {
        let d = cwd.join(".claude").join("skills").join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), body).unwrap();
    }

    /// A config dir with no skills of its own, so tests see only the project.
    fn only(cwd: &Path) -> Vec<SkillInfo> {
        list_skills(
            Some(cwd.join("empty-config").to_string_lossy().into()),
            Some(cwd.to_string_lossy().into()),
        )
    }

    #[test]
    fn frontmatter_wins_over_the_directory_name() {
        let cwd = tmp("fm");
        write_skill(&cwd, "folder-name", "---\nname: real-name\ndescription: Does a thing\n---\n\nbody");
        let got = only(&cwd);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "real-name");
        assert_eq!(got[0].description, "Does a thing");
        assert_eq!(got[0].source, "project");
    }

    #[test]
    fn a_skill_with_no_frontmatter_is_still_listed() {
        let cwd = tmp("broken");
        write_skill(&cwd, "no-frontmatter", "just a markdown file\n");
        let got = only(&cwd);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "no-frontmatter");
        assert_eq!(got[0].description, "");
    }

    #[test]
    fn a_directory_without_a_skill_md_is_not_a_skill() {
        let cwd = tmp("empty");
        std::fs::create_dir_all(cwd.join(".claude").join("skills").join("not-a-skill")).unwrap();
        assert!(only(&cwd).is_empty());
    }

    #[test]
    fn missing_directories_are_normal_and_yield_nothing() {
        let cwd = tmp("gone");
        assert!(only(&cwd.join("nowhere")).is_empty());
    }
}
