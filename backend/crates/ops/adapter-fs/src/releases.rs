// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::path::{Path, PathBuf};

use console_ops_application::changes::{ReleaseArtifact, ReleasesStore};
use console_ops_application::domain::changes::{
    GateStatement, is_valid_sha256_digest, parse_gate_statement,
};

const MAX_GATES_BYTES: u64 = 1_048_576;

pub struct FsReleasesStore {
    root: PathBuf,
}

impl FsReleasesStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn read_gates_file(
        &self,
        digest: &str,
        dir_path: &Path,
    ) -> Result<Option<GateStatement>, String> {
        let dir_meta =
            fs::symlink_metadata(dir_path).map_err(|_| "release dir unreadable".to_owned())?;
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            return Err("release digest path must be a regular directory".to_owned());
        }
        let gates_path = dir_path.join("gates.json");
        let meta = match fs::symlink_metadata(&gates_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("gates.json unreadable".to_owned()),
        };
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_GATES_BYTES {
            return Err("gates.json must be a regular file <= 1 MiB".to_owned());
        }
        let raw =
            fs::read_to_string(&gates_path).map_err(|_| "gates.json unreadable".to_owned())?;
        parse_gate_statement(&raw, Some(digest))
            .map(Some)
            .map_err(|e| e.0)
    }
}

impl ReleasesStore for FsReleasesStore {
    fn list_releases(&self) -> Result<Vec<ReleaseArtifact>, String> {
        let root_meta = match fs::symlink_metadata(&self.root) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("releases dir unreadable".to_owned()),
        };
        if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
            return Err("releases dir must be a regular directory".to_owned());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| "releases dir unreadable".to_owned())? {
            let entry = entry.map_err(|_| "releases dir entry unreadable".to_owned())?;
            let name = entry.file_name();
            let Some(digest) = name.to_str() else {
                continue;
            };
            if !is_valid_sha256_digest(digest) {
                continue;
            }
            match self.read_gates_file(digest, &entry.path()) {
                Ok(Some(gates)) => out.push(ReleaseArtifact {
                    digest: digest.to_owned(),
                    gates: Some(gates),
                    missing_reason: None,
                }),
                Ok(None) => out.push(ReleaseArtifact {
                    digest: digest.to_owned(),
                    gates: None,
                    missing_reason: Some("gate missing".to_owned()),
                }),
                Err(reason) => out.push(ReleaseArtifact {
                    digest: digest.to_owned(),
                    gates: None,
                    missing_reason: Some(reason),
                }),
            }
        }
        out.sort_by(|a, b| a.digest.cmp(&b.digest));
        Ok(out)
    }

    fn get_gates(&self, digest: &str) -> Result<Option<GateStatement>, String> {
        if !is_valid_sha256_digest(digest) {
            return Err("invalid sha256 digest".to_owned());
        }
        let dir_path = self.root.join(digest);
        match fs::symlink_metadata(&dir_path) {
            Ok(_) => self.read_gates_file(digest, &dir_path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("release dir unreadable".to_owned()),
        }
    }
}
