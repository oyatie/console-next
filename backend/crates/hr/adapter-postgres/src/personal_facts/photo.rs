//! 사진 uploads. The REST layer holds the object store: it asks here for an
//! upload record ([`HrService::issue_photo_upload`]) and presigns a PUT for
//! its key; after the browser's PUT it HEADs the key and calls
//! [`HrService::confirm_photo_upload`]. The confirmed upload id is then the
//! `photo` value of a correction. Keys are made here, org-prefixed, never
//! taken from the client; audit rows carry ids, type and size, never keys.

use console_hr_domain::personal::check_photo;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{authorize_hr_person, hr_reach};
use crate::{HrError, HrService};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhotoUploadRequest {
    #[serde(deserialize_with = "deserialize_enum_21")]
    pub content_type: String,
    pub byte_size: i64,
}

/// An issued upload; `object_key` is for the REST layer to presign and is
/// never serialized.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoUpload {
    pub upload_id: Uuid,
    pub employee_id: Uuid,
    pub content_type: String,
    pub byte_size: i64,
    pub confirmed: bool,
    #[serde(skip)]
    pub object_key: String,
}

fn not_found(message: &str) -> HrError {
    HrError::from_kernel(KernelError::not_found(message.to_owned()))
}

fn event(principal: &Principal, action: &str, upload: &PhotoUpload) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee",
        upload.employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(
        None,
        Some(json!({
            "upload_id": upload.upload_id,
            "content_type": upload.content_type,
            "byte_size": upload.byte_size,
        })),
    ))
}

impl HrService {
    /// Records a new 사진 upload for `employee_id` and returns it with its
    /// server-made key.
    pub async fn issue_photo_upload(
        &self,
        principal: Principal,
        employee_id: Uuid,
        body: PhotoUploadRequest,
    ) -> Result<PhotoUpload, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let content_type = check_photo(&body.content_type, body.byte_size)
            .map_err(HrError::from_kernel)?
            .to_owned();
        let byte_size = body.byte_size;
        let stored_size = i32::try_from(byte_size)
            .map_err(|_| HrError::validation("byte_size is out of range"))?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let upload_id = Uuid::new_v4();
        let object_key = format!("{org_uuid}/hr/employee-photos/{employee_id}/{upload_id}");
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND id = $2)",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                if !exists {
                    return Err(not_found("employee was not found in this organization"));
                }
                sqlx::query(
                    "INSERT INTO employee_photo_uploads (org_id, id, employee_id, object_key, \
                     content_type, byte_size, issued_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(org_uuid)
                .bind(upload_id)
                .bind(employee_id)
                .bind(&object_key)
                .bind(&content_type)
                .bind(stored_size)
                .bind(*principal.user_id.as_uuid())
                .execute(tx.as_mut())
                .await?;
                let upload = PhotoUpload {
                    upload_id,
                    employee_id,
                    content_type,
                    byte_size,
                    confirmed: false,
                    object_key,
                };
                let audit = event(&principal, "employee.photo.upload_issue", &upload)?;
                Ok((upload, vec![audit]))
            })
        })
        .await
    }

    /// One upload of `employee_id`, for the confirm step's HEAD.
    pub async fn photo_upload(
        &self,
        principal: Principal,
        employee_id: Uuid,
        upload_id: Uuid,
    ) -> Result<PhotoUpload, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee_id).await?;
                let row = sqlx::query(
                    "SELECT object_key, content_type, byte_size, confirmed_at IS NOT NULL AS confirmed \
                     FROM employee_photo_uploads WHERE org_id = $1 AND id = $2 AND employee_id = $3",
                )
                .bind(org_uuid)
                .bind(upload_id)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| not_found("no photo upload with this id exists for this employee"))?;
                let size: i32 = row.try_get("byte_size")?;
                let upload = PhotoUpload {
                    upload_id,
                    employee_id,
                    content_type: row.try_get("content_type")?,
                    byte_size: i64::from(size),
                    confirmed: row.try_get("confirmed")?,
                    object_key: row.try_get("object_key")?,
                };
                Ok((upload, Vec::new()))
            })
        })
        .await
    }

    /// Marks an upload as present in storage (the caller HEADed its key and
    /// found the declared size). Confirming twice is a no-op.
    pub async fn confirm_photo_upload(
        &self,
        principal: Principal,
        upload: PhotoUpload,
    ) -> Result<PhotoUpload, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    upload.employee_id,
                )
                .await?;
                let done = sqlx::query(
                    "UPDATE employee_photo_uploads SET confirmed_at = now() \
                     WHERE org_id = $1 AND id = $2 AND employee_id = $3 AND confirmed_at IS NULL",
                )
                .bind(org_uuid)
                .bind(upload.upload_id)
                .bind(upload.employee_id)
                .execute(tx.as_mut())
                .await?;
                let upload = PhotoUpload {
                    confirmed: true,
                    ..upload
                };
                let events = if done.rows_affected() == 1 {
                    vec![event(&principal, "employee.photo.upload_confirm", &upload)?]
                } else {
                    Vec::new()
                };
                Ok((upload, events))
            })
        })
        .await
    }
}

fn deserialize_enum_21<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["image/jpeg", "image/png", "image/webp"],
    )
}
