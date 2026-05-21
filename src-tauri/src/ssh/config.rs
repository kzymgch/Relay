//! Minimal `~/.ssh/config` parser scoped to the keys Relay's SSH panes need.
//!
//! We deliberately avoid pulling in a full OpenSSH-grammar parser (the
//! `ssh2-config` crate transitively builds `git2` + `openssl-sys`). The grammar
//! we support: `Host <pattern>` blocks, each holding zero or more
//! `Key value` lines. Comments (`#`) and blank lines are ignored.
//!
//! Recognised keys (all others ignored): `HostName`, `User`, `Port`,
//! `IdentityFile`. Pattern matching is exact-or-glob (`*` and `?`), per
//! ssh_config(5). `Host *` is the catch-all default.
//!
//! Output is `ResolvedSshTarget`: the connect-time values to feed russh,
//! after merging an alias's block with any explicit overrides the pane spec
//! provided.

use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedSshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct HostBlock {
    pub patterns: Vec<String>,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct SshConfig {
    pub blocks: Vec<HostBlock>,
}

#[derive(Debug, Clone)]
pub struct SshTargetOverride {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_path: Option<String>,
    pub ssh_config_alias: Option<String>,
}

impl SshConfig {
    pub fn parse(input: &str) -> Self {
        let mut blocks: Vec<HostBlock> = Vec::new();
        let mut current: Option<HostBlock> = None;
        for raw in input.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Tokens are whitespace-separated. ssh_config also accepts
            // `Key=Value` with no whitespace; we normalise by replacing `=`
            // with a space before splitting, which is the same behaviour as
            // OpenSSH (it tokenises on whitespace and `=`).
            let normalised = line.replacen('=', " ", 1);
            let mut tokens = normalised.split_whitespace();
            let Some(key) = tokens.next() else { continue };
            let value: String = tokens.collect::<Vec<_>>().join(" ");
            if value.is_empty() {
                continue;
            }
            if key.eq_ignore_ascii_case("Host") {
                if let Some(prev) = current.take() {
                    blocks.push(prev);
                }
                current = Some(HostBlock {
                    patterns: value.split_whitespace().map(str::to_string).collect(),
                    ..Default::default()
                });
                continue;
            }
            let Some(block) = current.as_mut() else {
                continue;
            };
            if key.eq_ignore_ascii_case("HostName") {
                block.host_name = Some(value);
            } else if key.eq_ignore_ascii_case("User") {
                block.user = Some(value);
            } else if key.eq_ignore_ascii_case("Port") {
                if let Ok(p) = value.parse::<u16>() {
                    block.port = Some(p);
                }
            } else if key.eq_ignore_ascii_case("IdentityFile") {
                block.identity_file = Some(value);
            }
            // Everything else is silently ignored — we don't claim to be a
            // full ssh_config implementation.
        }
        if let Some(last) = current.take() {
            blocks.push(last);
        }
        SshConfig { blocks }
    }

    /// All host aliases (first pattern in each block) suitable for the
    /// settings GUI dropdown. Wildcard-only blocks (`Host *`) are omitted
    /// because the user can't connect *to* a glob.
    pub fn aliases(&self) -> Vec<String> {
        self.blocks
            .iter()
            .flat_map(|b| b.patterns.iter())
            .filter(|p| !p.contains(['*', '?']))
            .cloned()
            .collect()
    }

    /// Look up the first block that matches `alias` and merge with overrides
    /// from the pane spec. Explicit overrides win over ssh_config values; the
    /// final fallback for `port` is 22 and for `user` the current OS user.
    pub fn resolve(&self, ov: &SshTargetOverride, default_user: &str) -> ResolvedSshTarget {
        // Block lookup: when an alias is given we match against patterns;
        // otherwise we treat the override host literally. The catch-all
        // `Host *` block (if present) supplies cross-host defaults.
        let alias_target = ov.ssh_config_alias.as_deref().unwrap_or(&ov.host);
        let mut merged = HostBlock::default();
        for block in &self.blocks {
            if block
                .patterns
                .iter()
                .any(|p| matches_pattern(p, alias_target))
            {
                if merged.host_name.is_none() {
                    merged.host_name = block.host_name.clone();
                }
                if merged.user.is_none() {
                    merged.user = block.user.clone();
                }
                if merged.port.is_none() {
                    merged.port = block.port;
                }
                if merged.identity_file.is_none() {
                    merged.identity_file = block.identity_file.clone();
                }
            }
        }
        // When the user picked an alias, the alias's HostName replaces the
        // literal `host` (which is just the alias key in that case). When no
        // alias is given, the override `host` is the real target — and we
        // still let a wildcard `Host *` block contribute a HostName mapping
        // if any.
        let host = merged.host_name.clone().unwrap_or_else(|| ov.host.clone());
        ResolvedSshTarget {
            host,
            port: ov.port.or(merged.port).unwrap_or(22),
            user: ov
                .user
                .clone()
                .or_else(|| merged.user.clone())
                .unwrap_or_else(|| default_user.to_string()),
            identity_path: ov
                .identity_path
                .clone()
                .or(merged.identity_file)
                .map(expand_tilde),
        }
    }
}

/// Glob-style match: `*` matches any run, `?` matches one char, anything
/// else literal. Case-sensitive (ssh_config patterns are case-sensitive).
fn matches_pattern(pattern: &str, candidate: &str) -> bool {
    if !pattern.contains(['*', '?']) {
        return pattern == candidate;
    }
    // Convert glob to a simple recursive match.
    glob_match(pattern.as_bytes(), candidate.as_bytes())
}

fn glob_match(pat: &[u8], s: &[u8]) -> bool {
    match (pat.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            // Either consume zero from s, or one and keep the '*'.
            if glob_match(&pat[1..], s) {
                return true;
            }
            !s.is_empty() && glob_match(pat, &s[1..])
        }
        (Some(b'?'), Some(_)) => glob_match(&pat[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob_match(&pat[1..], &s[1..]),
        _ => false,
    }
}

pub fn expand_tilde(p: impl Into<String>) -> PathBuf {
    let raw: String = p.into();
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
# Personal hosts
Host devbox
    HostName devbox.internal.example.com
    User alice
    Port 2222
    IdentityFile ~/.ssh/id_ed25519_dev

Host gpu*
    User trainer
    IdentityFile ~/.ssh/id_ml

Host *
    User defaultuser
    Port 22
"#;

    #[test]
    fn resolves_exact_alias_with_all_fields() {
        let cfg = SshConfig::parse(FIXTURE);
        let target = cfg.resolve(
            &SshTargetOverride {
                host: "devbox".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: Some("devbox".into()),
            },
            "currentuser",
        );
        assert_eq!(target.host, "devbox.internal.example.com");
        assert_eq!(target.port, 2222);
        assert_eq!(target.user, "alice");
        assert!(target
            .identity_path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .ends_with(".ssh/id_ed25519_dev"));
    }

    #[test]
    fn override_wins_over_ssh_config() {
        let cfg = SshConfig::parse(FIXTURE);
        let target = cfg.resolve(
            &SshTargetOverride {
                host: "devbox".into(),
                port: Some(2200),
                user: Some("bob".into()),
                identity_path: Some("/tmp/key".into()),
                ssh_config_alias: Some("devbox".into()),
            },
            "currentuser",
        );
        assert_eq!(target.port, 2200, "port override should win");
        assert_eq!(target.user, "bob", "user override should win");
        assert_eq!(
            target.identity_path.unwrap(),
            PathBuf::from("/tmp/key"),
            "identity_path override should win"
        );
    }

    #[test]
    fn wildcard_block_supplies_defaults() {
        let cfg = SshConfig::parse(FIXTURE);
        let target = cfg.resolve(
            &SshTargetOverride {
                host: "randombox".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: None,
            },
            "currentuser",
        );
        // `Host *` matches everything, so its `User defaultuser` applies.
        assert_eq!(target.user, "defaultuser");
        assert_eq!(target.port, 22);
        assert_eq!(target.host, "randombox");
    }

    #[test]
    fn glob_alias_matches_pattern() {
        let cfg = SshConfig::parse(FIXTURE);
        // gpu* should match gpu01 and gpu-train but not "gpu" alone? Actually
        // gpu* matches "gpu" too. Test both.
        let t1 = cfg.resolve(
            &SshTargetOverride {
                host: "gpu01".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: Some("gpu01".into()),
            },
            "currentuser",
        );
        assert_eq!(t1.user, "trainer", "gpu* should match gpu01");

        let t2 = cfg.resolve(
            &SshTargetOverride {
                host: "other".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: Some("other".into()),
            },
            "currentuser",
        );
        assert_eq!(
            t2.user, "defaultuser",
            "non-matching alias falls through to Host *"
        );
    }

    #[test]
    fn aliases_excludes_wildcards() {
        let cfg = SshConfig::parse(FIXTURE);
        let aliases = cfg.aliases();
        assert!(aliases.contains(&"devbox".to_string()));
        assert!(!aliases.contains(&"gpu*".to_string()));
        assert!(!aliases.contains(&"*".to_string()));
    }

    #[test]
    fn parser_handles_equals_separator_and_comments() {
        // OpenSSH accepts `Key=Value` and `# comments` mid-block.
        let cfg =
            SshConfig::parse("Host eq\n  HostName=eq.example.com\n  # comment\n  Port = 2022\n");
        let target = cfg.resolve(
            &SshTargetOverride {
                host: "eq".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: Some("eq".into()),
            },
            "currentuser",
        );
        assert_eq!(target.host, "eq.example.com");
        assert_eq!(target.port, 2022);
    }

    #[test]
    fn unknown_alias_falls_back_to_literal_host() {
        let cfg = SshConfig::parse("Host known\n  User k\n");
        let target = cfg.resolve(
            &SshTargetOverride {
                host: "literal.example.com".into(),
                port: None,
                user: None,
                identity_path: None,
                ssh_config_alias: Some("nope".into()),
            },
            "currentuser",
        );
        assert_eq!(target.host, "literal.example.com");
        assert_eq!(target.user, "currentuser");
        assert_eq!(target.port, 22);
    }
}
