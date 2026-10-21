//! `GET /api/v1/employees/voided`: the 「취소된 등록」 list. The one read that
//! opens the `hide_voided` policy, inside its own transaction; it is a
//! personal-data list read, so it writes its 접속기록 row (INF-02).

use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct VoidedEmployee {
    pub employee_id: Uuid,
    /// None once a SETUP delete freed it.
    pub employee_number: Option<String>,
    /// The name until the personal data is destroyed, then `(파기됨)`.
    pub name: String,
    pub void_reason_code: String,
    /// SETUP, GOVERNED or SOLE_HOLDER.
    pub void_mode: String,
    pub voided_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub voided_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub pii_destroyed_at: Option<OffsetDateTime>,
}

impl HrService {
    /// Newest first, at most 500.
    ///
    /// # Errors
    /// 403 without org-wide `employee_directory_manage`.
    pub async fn list_voided(&self, principal: Principal) -> Result<Vec<VoidedEmployee>, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                include_voided(tx, true).await?;
                let rows: Vec<VoidedEmployee> = sqlx::query_as(
                    "SELECT id AS employee_id, employee_number, name, void_reason_code, void_mode, \
                     voided_by, voided_at, pii_destroyed_at FROM employees \
                     WHERE org_id = $1 AND voided_at IS NOT NULL \
                     ORDER BY voided_at DESC, id LIMIT 500",
                )
                .bind(org_uuid)
                .fetch_all(tx.as_mut())
                .await?;
                include_voided(tx, false).await?;
                let subjects: Vec<Uuid> = rows.iter().map(|row| row.employee_id).collect();
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &subjects,
                    me,
                    json!({ "view": "voided" }),
                )?;
                Ok((rows, vec![event]))
            })
        })
        .await
    }
}
