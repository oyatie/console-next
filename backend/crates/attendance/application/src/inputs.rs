//! The caller's scope and the shared input checks of every attendance command
//! (moved out of lib.rs).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AttendanceApplicationError;

pub fn validate_idempotency_key(key: &str) -> Result<String, AttendanceApplicationError> {
    let key = key.trim();
    if !(16..=200).contains(&key.len()) {
        return Err(AttendanceApplicationError::InvalidIdempotencyKey);
    }
    Ok(key.to_owned())
}
pub fn validate_text(
    value: &str,
    name: &'static str,
    max: usize,
) -> Result<String, AttendanceApplicationError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(AttendanceApplicationError::InvalidText(name));
    }
    Ok(value.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallerScope {
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub branch_ids: Vec<Uuid>,
    pub org_wide: bool,
}
impl CallerScope {
    pub fn permits_branch(&self, branch_id: Option<Uuid>) -> bool {
        self.org_wide || branch_id.is_some_and(|id| self.branch_ids.contains(&id))
    }
}
