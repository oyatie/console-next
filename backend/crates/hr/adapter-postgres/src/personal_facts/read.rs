//! `GET /employees/{id}/personal-facts`: the 인적사항 extras HR holds for one
//! employee. Personal data a directory reader does not see, so the read
//! needs `employee_directory_manage` and leaves a 접속기록 row like the
//! detail read. The REST layer turns `photo.object_key` into a short-lived
//! presigned GET; the key itself is never serialized.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use super::ledger_value;
use super::store::load_in_tx;
use crate::authz::{authorize_hr_person, hr_reach};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

#[derive(Debug, Serialize)]
pub struct PersonalPhoto {
    pub upload_id: Uuid,
    pub content_type: String,
    /// A short-lived presigned GET, filled by the REST layer; null when
    /// object storage is not configured.
    pub url: Option<String>,
    #[serde(skip)]
    pub object_key: String,
}

#[derive(Debug, Serialize)]
pub struct PersonalFactsResponse {
    pub employee_id: Uuid,
    /// The employee's version: send it as `expected_updated_at` with the
    /// `PATCH /employees/{id}` that corrects these items.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub name_hanja: Option<String>,
    pub name_en: Option<String>,
    /// ISO 3166-1 alpha-2; null = 미입력.
    pub nationality: Option<String>,
    pub personal_email: Option<String>,
    /// `[{name, relation, phone}]`; null = 미입력.
    pub emergency_contacts: Value,
    pub photo: Option<PersonalPhoto>,
    /// 그룹 입사일 (근속 기산일), `YYYY-MM-DD`.
    pub group_service_start_date: Option<String>,
}

impl HrService {
    pub async fn personal_facts(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<PersonalFactsResponse, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                let updated_at: OffsetDateTime = sqlx::query_scalar(
                    "SELECT updated_at FROM employees WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(console_kernel_core::KernelError::not_found(
                        "employee was not found in this organization",
                    ))
                })?;
                let row = load_in_tx(tx, org_uuid, employee_id).await?;
                let photo = match row.photo.as_deref().map(Uuid::parse_str) {
                    Some(Ok(upload_id)) => {
                        let found = sqlx::query(
                            "SELECT object_key, content_type FROM employee_photo_uploads \
                             WHERE org_id = $1 AND id = $2",
                        )
                        .bind(org_uuid)
                        .bind(upload_id)
                        .fetch_one(tx.as_mut())
                        .await?;
                        Some(PersonalPhoto {
                            upload_id,
                            content_type: found.try_get("content_type")?,
                            url: None,
                            object_key: found.try_get("object_key")?,
                        })
                    }
                    _ => None,
                };
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::Detail,
                    &[employee_id],
                    me,
                    json!({ "view": "personal_facts" }),
                )?;
                let response = PersonalFactsResponse {
                    employee_id,
                    updated_at,
                    name_hanja: row.name_hanja,
                    name_en: row.name_en,
                    nationality: row.nationality,
                    personal_email: row.personal_email,
                    emergency_contacts: ledger_value(
                        "emergency_contacts",
                        row.emergency_contacts.as_deref(),
                    ),
                    photo,
                    group_service_start_date: row.group_service_start_date,
                };
                Ok((response, vec![event]))
            })
        })
        .await
    }
}
