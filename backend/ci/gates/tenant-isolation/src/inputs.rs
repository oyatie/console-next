// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    GateResult, Violation, ViolationKind, check_audit_tx_guc_bind, check_migrations,
    collect_migration_files, collect_rust_files,
};
use std::path::Path;

pub fn check_workspace(workspace_dir: &Path) -> Result<GateResult, String> {
    let mut result = GateResult::default();

    let migration_files = migration_inputs(workspace_dir)?;
    check_migrations(migration_files, &mut result);

    let rust_files = collect_rust_files(workspace_dir)?;
    check_audit_tx_guc_bind(&rust_files, &mut result);

    Ok(result)
}

/// Check a migrations directory in isolation (used by the unit tests).
///
/// `root` is a directory that CONTAINS a `migrations/` subdirectory (the scan
/// descends into it), mirroring `check_workspace`'s discovery.
#[must_use]
pub fn check_migrations_root(root: &Path) -> GateResult {
    let mut result = GateResult::default();
    match migration_inputs(root) {
        Ok(files) => check_migrations(files, &mut result),
        Err(e) => result.violations.push(Violation {
            kind: ViolationKind::ScanError,
            file: root.to_path_buf(),
            detail: e,
        }),
    }
    result
}

fn migration_inputs(root: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let files = collect_migration_files(root)?;
    if files.is_empty() {
        return Err(format!("no SQL migrations found under {}", root.display()));
    }
    Ok(files)
}
