// SPDX-License-Identifier: LicenseRef-Proprietary
//! The erasure receipt retains the target identity after the tenant is gone.
use aws_lc_rs::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TenantEraseCommand {
    Open,
    Approve,
    Cancel,
}
impl TenantEraseCommand {
    pub const fn action(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Approve => "approve",
            Self::Cancel => "cancel",
        }
    }
    pub fn payload_hash(self, org: Uuid, id: Uuid) -> String {
        let payload = format!("tenant_erase:{org}:{id}:{}", self.action());
        let bytes = digest(&SHA256, payload.as_bytes());
        bytes
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TenantEraseRequest {
    pub id: Uuid,
    pub target_org_id: Uuid,
    pub requested_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub opened_at: OffsetDateTime,
    pub approved_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub cooling_until: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub cancelled_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub erased_at: Option<OffsetDateTime>,
}
#[derive(Debug, Serialize)]
pub struct TenantEraseRead {
    pub request: Option<TenantEraseRequest>,
    pub second_operator_available: bool,
    pub archived: bool,
    pub legal_hold: bool,
    pub cooling_hours: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_hash_matches_sha256_vector() {
        assert_eq!(
            TenantEraseCommand::Open.payload_hash(Uuid::nil(), Uuid::nil()),
            "eb0bee879d3a5deae7f15b9236b30b8468b7ae144a28ba63a62c6207e85701c9"
        );
    }
}
