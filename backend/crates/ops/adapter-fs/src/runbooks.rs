// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::path::{Component, Path, PathBuf};

use console_ops_application::domain::runbook::extract_runbook_anchors;
use console_ops_application::runbooks::{RunbookDoc, RunbookDocMeta, RunbookError, RunbookStore};

const MAX_RUNBOOK_BYTES: u64 = 1_048_576;
const DOCS_SUBDIR: &str = "docs";

pub struct FsRunbookStore {
    root: PathBuf,
}

impl FsRunbookStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            root: config_dir.join("runbooks"),
        }
    }

    fn is_docs_rel(rel: &str) -> bool {
        rel.strip_prefix(DOCS_SUBDIR)
            .is_some_and(|rest| rest.starts_with('/'))
    }

    fn is_excluded_rel(rel: &str) -> bool {
        rel.split('/').any(|seg| {
            seg.eq_ignore_ascii_case("patches")
                || seg.eq_ignore_ascii_case("script-ledger.tsv")
                || seg.eq_ignore_ascii_case("ops-backlog.md")
        })
    }

    fn is_allowed_rel(rel: &str) -> bool {
        if Self::is_excluded_rel(rel) {
            return false;
        }
        rel == "RUNBOOK.md" || (Self::is_docs_rel(rel) && rel.ends_with(".md"))
    }

    fn safe_join(&self, rel: &str) -> Result<PathBuf, RunbookError> {
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.contains('\\')
            || rel.contains('%')
            || rel.contains("..")
            || rel.chars().any(char::is_control)
            || rel
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(RunbookError::InvalidPath);
        }
        let rel_path = Path::new(rel);
        let mut normalized_segs = Vec::new();
        for comp in rel_path.components() {
            match comp {
                Component::Normal(seg) => {
                    let s = seg.to_str().ok_or(RunbookError::InvalidPath)?;
                    normalized_segs.push(s);
                }
                _ => return Err(RunbookError::InvalidPath),
            }
        }
        let normalized = normalized_segs.join("/");
        if Self::is_excluded_rel(&normalized) || !Self::is_allowed_rel(&normalized) {
            return Err(RunbookError::InvalidPath);
        }
        let root_meta = fs::symlink_metadata(&self.root).map_err(|_| RunbookError::NotFound)?;
        if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
            return Err(RunbookError::Unreadable);
        }
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|_| RunbookError::Unreadable)?;

        let mut cur = self.root.clone();
        for comp in rel_path.components() {
            cur.push(comp.as_os_str());
            let meta = fs::symlink_metadata(&cur).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    RunbookError::NotFound
                } else {
                    RunbookError::Unreadable
                }
            })?;
            if meta.file_type().is_symlink() {
                return Err(RunbookError::InvalidPath);
            }
        }
        let canonical = cur.canonicalize().map_err(|_| RunbookError::Unreadable)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(RunbookError::InvalidPath);
        }
        let meta = fs::symlink_metadata(&canonical).map_err(|_| RunbookError::Unreadable)?;
        if !meta.is_file() || meta.len() > MAX_RUNBOOK_BYTES {
            return Err(RunbookError::Unreadable);
        }
        Ok(canonical)
    }

    fn collect_docs(
        &self,
        dir: &Path,
        prefix: &str,
        out: &mut Vec<RunbookDocMeta>,
    ) -> Result<(), RunbookError> {
        let dir_meta = fs::symlink_metadata(dir).map_err(|_| RunbookError::Unreadable)?;
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            return Err(RunbookError::Unreadable);
        }
        for entry in fs::read_dir(dir).map_err(|_| RunbookError::Unreadable)? {
            let entry = entry.map_err(|_| RunbookError::Unreadable)?;
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name_str.to_owned()
            } else {
                format!("{prefix}/{name_str}")
            };
            if Self::is_excluded_rel(&rel) {
                continue;
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| RunbookError::Unreadable)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if rel == DOCS_SUBDIR || Self::is_docs_rel(&rel) {
                    self.collect_docs(&path, &rel, out)?;
                }
            } else if meta.is_file()
                && Self::is_allowed_rel(&rel)
                && meta.len() <= MAX_RUNBOOK_BYTES
            {
                let content = fs::read_to_string(&path).map_err(|_| RunbookError::Unreadable)?;
                out.push(RunbookDocMeta {
                    path: rel,
                    anchors: extract_runbook_anchors(&content),
                });
            }
        }
        Ok(())
    }
}

impl RunbookStore for FsRunbookStore {
    fn list_docs(&self) -> Result<Vec<RunbookDocMeta>, RunbookError> {
        match fs::symlink_metadata(&self.root) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(RunbookError::Unreadable);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(RunbookError::Unreadable),
        }
        let mut docs = Vec::new();
        self.collect_docs(&self.root, "", &mut docs)?;
        docs.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(docs)
    }

    fn read_doc(&self, rel_path: &str) -> Result<RunbookDoc, RunbookError> {
        let canonical = self.safe_join(rel_path)?;
        let content = fs::read_to_string(canonical).map_err(|_| RunbookError::Unreadable)?;
        let anchors = extract_runbook_anchors(&content);
        Ok(RunbookDoc {
            path: rel_path.to_owned(),
            content,
            anchors,
        })
    }
}
