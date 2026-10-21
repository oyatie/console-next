//! Examined-count ratchet: the number of state-changing functions the gate
//! saw may not drop below the recorded floor, so a scan-set or detector change
//! cannot silently stop looking at code.

use std::path::Path;

/// The recorded floor, relative to the backend root.
pub const FLOOR_FILE: &str = "ci/gates/audit-coverage/examined.txt";

/// `Err` when `examined` is below the floor in [`FLOOR_FILE`], or the floor is
/// missing or unreadable (fail closed).
///
/// # Errors
/// The floor file cannot be read or parsed, or `examined` is below it.
pub fn check_floor(workspace_dir: &Path, examined: usize) -> Result<(), String> {
    let path = workspace_dir.join(FLOOR_FILE);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let floor: usize = text
        .trim()
        .parse()
        .map_err(|e| format!("{FLOOR_FILE} is not a count: {e}"))?;
    if examined < floor {
        return Err(format!(
            "examined={examined} is below the floor {floor} in {FLOOR_FILE}; \
             a scan-set or detector change stopped looking at state-changing code"
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn workspace(floor: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "audit-coverage-floor-{}-{}",
            std::process::id(),
            floor.unwrap_or("none")
        ));
        let gate = dir.join("ci/gates/audit-coverage");
        std::fs::create_dir_all(&gate).unwrap();
        let file = gate.join("examined.txt");
        match floor {
            Some(text) => std::fs::write(file, text).unwrap(),
            None => drop(std::fs::remove_file(file)),
        }
        dir
    }

    #[test]
    fn floor_holds_at_and_above_and_fails_below() {
        let dir = workspace(Some("107\n"));
        assert!(check_floor(&dir, 107).is_ok());
        assert!(check_floor(&dir, 108).is_ok());
        assert!(check_floor(&dir, 106).unwrap_err().contains("examined=106"));
    }

    #[test]
    fn missing_or_garbled_floor_fails_closed() {
        assert!(check_floor(&workspace(None), 1_000).is_err());
        assert!(check_floor(&workspace(Some("many")), 1_000).is_err());
    }
}
