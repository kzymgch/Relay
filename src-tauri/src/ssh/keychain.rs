//! macOS Keychain wrapper for SSH passwords / key passphrases.
//!
//! Service key is fixed to `"relay-ssh"`; the account is the caller-supplied
//! `<user>@<host>` string. Plaintext never leaves Rust — the frontend can
//! `set`, `delete`, or check `has` but cannot read back stored secrets.
//!
//! Integration tests are `#[ignore]`-gated because they mutate the user's
//! login keychain and prompt for permission on first write. CI skips them.

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords;

    pub const SERVICE: &str = "relay-ssh";

    pub fn set(account: &str, password: &str) -> Result<(), String> {
        passwords::set_generic_password(SERVICE, account, password.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match passwords::get_generic_password(SERVICE, account) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) => {
                // SecError -25300 is errSecItemNotFound — treat as "absent".
                let msg = e.to_string();
                if msg.contains("-25300") || msg.to_lowercase().contains("not found") {
                    Ok(None)
                } else {
                    Err(msg)
                }
            }
        }
    }

    pub fn has(account: &str) -> bool {
        matches!(get(account), Ok(Some(_)))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        passwords::delete_generic_password(SERVICE, account).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    // Non-macOS targets exist only for the test build matrix; Relay itself
    // ships macOS-only. The stub returns a fixed error so any unexpected
    // invocation fails loudly rather than silently succeeding.
    pub const SERVICE: &str = "relay-ssh";

    pub fn set(_account: &str, _password: &str) -> Result<(), String> {
        Err("Keychain is only available on macOS".into())
    }
    pub fn get(_account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn has(_account: &str) -> bool {
        false
    }
    pub fn delete(_account: &str) -> Result<(), String> {
        Err("Keychain is only available on macOS".into())
    }
}

pub use imp::{delete, get, has, set, SERVICE};

/// Standard account-name convention. Centralised so both the Rust SSH client
/// and the Tauri commands agree on the lookup key.
pub fn account_for(user: &str, host: &str) -> String {
    format!("{user}@{host}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_format_is_user_at_host() {
        // Frontend and backend both build the lookup key the same way;
        // diverging here would silently lose stored passwords.
        assert_eq!(
            account_for("alice", "dev.example.com"),
            "alice@dev.example.com"
        );
    }

    // Round-trip test — mutates the real keychain, so #[ignore]-gated.
    // Run locally with `cargo test ssh::keychain -- --ignored`.
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let account = "relay-test@example.invalid";
        let _ = delete(account); // ignore "not found"
        assert!(!has(account));
        set(account, "hunter2").expect("set");
        assert!(has(account));
        assert_eq!(get(account).unwrap().as_deref(), Some("hunter2"));
        delete(account).expect("delete");
        assert!(!has(account));
    }
}
