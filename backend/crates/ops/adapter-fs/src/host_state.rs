// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::path::{Path, PathBuf};

use console_ops_application::actions::parse_compact_utc;
use console_ops_application::changes::{ConfigHistoryEntry, DeployHistoryEntry, HostStateStore};
use serde_json::Value;

const MAX_STATE_FILE_BYTES: u64 = 1_048_576;

pub struct FsHostStateStore {
    root: PathBuf,
}

impl FsHostStateStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn read_regular(&self, name: &str) -> Option<String> {
        if !is_safe_state_root(&self.root) {
            return None;
        }
        let path = self.root.join(name);
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_STATE_FILE_BYTES {
            return None;
        }
        fs::read_to_string(path).ok()
    }
}

fn parse_kv_arg(parts: &[&str], key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    parts
        .iter()
        .find_map(|p| p.strip_prefix(&prefix))
        .filter(|v| *v != "none" && !v.is_empty())
        .map(str::to_owned)
}

pub fn parse_deploy_history(raw: &str) -> Vec<DeployHistoryEntry> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 4 {
                return None;
            }
            let at = parse_compact_utc(parts[0])?;
            let result = parts[1].to_owned();
            let from_digest = parse_kv_arg(&parts[2..], "from");
            let to_digest = parse_kv_arg(&parts[2..], "to");
            let msg_idx = parts[2..]
                .iter()
                .position(|p| !p.starts_with("from=") && !p.starts_with("to="))
                .map(|i| i + 2);
            let message = msg_idx
                .map(|i| parts[i..].join(" "))
                .unwrap_or_else(|| result.clone());
            Some(DeployHistoryEntry {
                at,
                result,
                from_digest,
                to_digest,
                message,
            })
        })
        .collect()
}

pub fn parse_config_history(raw: &str) -> Vec<ConfigHistoryEntry> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            let at = parse_compact_utc(parts[0])?;
            let result = parts[1].to_owned();
            let sha = parse_kv_arg(&parts[2..], "sha").unwrap_or_default();
            let msg_idx = parts[2..]
                .iter()
                .position(|p| !p.starts_with("sha="))
                .map(|i| i + 2);
            let message = msg_idx
                .map(|i| parts[i..].join(" "))
                .unwrap_or_else(|| result.clone());
            Some(ConfigHistoryEntry {
                at,
                result,
                sha,
                message,
            })
        })
        .collect()
}

impl HostStateStore for FsHostStateStore {
    fn read_deploy_history(&self) -> Option<Vec<DeployHistoryEntry>> {
        self.read_regular("deploy-history.log")
            .map(|raw| parse_deploy_history(&raw))
    }

    fn read_config_history(&self) -> Option<Vec<ConfigHistoryEntry>> {
        self.read_regular("config-history.log")
            .map(|raw| parse_config_history(&raw))
    }

    fn read_rollout(&self) -> Option<Value> {
        let raw = self.read_regular("rollout.json")?;
        serde_json::from_str(&raw).ok()
    }

    fn read_desired(&self) -> Option<Value> {
        let raw = self.read_regular("desired.json")?;
        serde_json::from_str(&raw).ok()
    }

    fn read_completed_requests(&self) -> Option<Vec<String>> {
        let raw = self.read_regular("requests.done")?;
        Some(
            raw.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }
}

pub fn is_safe_state_root(root: &Path) -> bool {
    fs::symlink_metadata(root)
        .map(|m| !m.file_type().is_symlink() && m.is_dir())
        .unwrap_or(false)
}
