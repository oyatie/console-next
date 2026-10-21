//! BW-13 / MR-25 classification catalog (`job_titles`): list, add, change. A
//! tenant's own five lists, typed by `kind` (직급 GRADE, 직위 TITLE, 직책
//! POSITION, 직무 JOB, 직군 JOB_FAMILY); GRADE and TITLE are ordered by
//! `grade_rank` (higher = more senior). No seed rows.

use console_hr_domain::lifecycle::classification::CATALOG_KINDS;
use console_hr_domain::lifecycle::job_title::normalize_job_title_label;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_scoped;
use crate::lifecycle::title_reason::coded;
use crate::{HrError, HrService};

mod authz;
use authz::{authorize_manage, may_manage};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JobTitleView {
    pub id: Uuid,
    /// GRADE, TITLE, POSITION, JOB or JOB_FAMILY.
    pub kind: String,
    pub label: String,
    pub grade_rank: Option<i32>,
    pub active: bool,
}

#[derive(Debug, Serialize)]
pub struct JobTitleList {
    pub items: Vec<JobTitleView>,
    /// The caller may add or change entries (`job_title_manage`): the
    /// inline 「+ 추가」 is offered only then.
    pub can_manage: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateJobTitleRequest {
    /// GRADE, TITLE, POSITION, JOB or JOB_FAMILY; fixed once added.
    #[serde(deserialize_with = "deserialize_enum_16")]
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub grade_rank: Option<i32>,
}

/// A change to one title; omitted fields stay. `grade_rank: null` is not
/// expressible here (a rank, once given, is changed, not removed).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateJobTitleRequest {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub grade_rank: Option<i32>,
    #[serde(default)]
    pub active: Option<bool>,
}

/// `?kind=` on the list.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobTitleListQuery {
    #[serde(default)]
    pub kind: Option<String>,
}

fn catalog_kind(raw: &str) -> Result<String, HrError> {
    let kind = raw.trim().to_ascii_uppercase();
    if CATALOG_KINDS.contains(&kind.as_str()) {
        return Ok(kind);
    }
    Err(coded(
        KernelError::validation("kind must be GRADE, TITLE, POSITION, JOB or JOB_FAMILY")
            .with_code("job_title_kind_invalid")
            .with_field("kind"),
    ))
}

/// Only 직급 and 직위 carry a rank (the 강등 check reads it).
fn rank_unranked_kind() -> HrError {
    coded(
        KernelError::validation("only GRADE and TITLE entries take a grade_rank")
            .with_code("job_title_rank_invalid")
            .with_field("grade_rank"),
    )
}

fn rank_in_range(grade_rank: Option<i32>) -> Result<(), HrError> {
    match grade_rank {
        Some(rank) if !(0..=1000).contains(&rank) => Err(coded(
            KernelError::validation("grade_rank must be 0 to 1000")
                .with_code("job_title_rank_invalid")
                .with_field("grade_rank"),
        )),
        _ => Ok(()),
    }
}

fn view(row: &sqlx::postgres::PgRow) -> Result<JobTitleView, HrError> {
    Ok(JobTitleView {
        id: row.try_get("id")?,
        kind: row.try_get("kind")?,
        label: row.try_get("label")?,
        grade_rank: row.try_get("grade_rank")?,
        active: row.try_get("active")?,
    })
}

fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    title: &JobTitleView,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "job_title",
        title.id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(json!(title))))
}

fn label_taken() -> HrError {
    coded(
        KernelError::conflict("another job title already has this label")
            .with_code("job_title_label_taken")
            .with_field("label"),
    )
}

impl HrService {
    /// Every entry of the tenant (or of one `kind`), by kind, most senior
    /// first, unranked last.
    pub async fn job_titles(
        &self,
        principal: Principal,
        query: JobTitleListQuery,
    ) -> Result<JobTitleList, HrError> {
        authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
        let kind = query.kind.as_deref().map(catalog_kind).transpose()?;
        let (org, can_manage) = (principal.org_id, may_manage(&principal));
        let items = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                sqlx::query(
                    "SELECT id, kind, label, grade_rank, active FROM job_titles \
                     WHERE org_id = $1 AND ($2::TEXT IS NULL OR kind = $2) \
                     ORDER BY kind, grade_rank DESC NULLS LAST, label",
                )
                .bind(org.as_uuid())
                .bind(kind)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(view)
                .collect::<Result<Vec<_>, HrError>>()
            })
        })
        .await?;
        Ok(JobTitleList { items, can_manage })
    }

    /// Adds a title. A label the tenant already has (ignoring case) returns
    /// that row (`false`), so a repeated add is harmless.
    pub async fn create_job_title(
        &self,
        principal: Principal,
        request: CreateJobTitleRequest,
    ) -> Result<(JobTitleView, bool), HrError> {
        authorize_manage(&principal)?;
        let label = normalize_job_title_label(&request.label).map_err(coded)?;
        let kind = catalog_kind(&request.kind)?;
        rank_in_range(request.grade_rank)?;
        if request.grade_rank.is_some() && !matches!(kind.as_str(), "GRADE" | "TITLE") {
            return Err(rank_unranked_kind());
        }
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let inserted = sqlx::query(
                    "INSERT INTO job_titles (org_id, kind, label, grade_rank, created_by) \
                     VALUES ($1, $5, $2, $3, $4) ON CONFLICT DO NOTHING \
                     RETURNING id, kind, label, grade_rank, active",
                )
                .bind(org.as_uuid())
                .bind(&label)
                .bind(request.grade_rank)
                .bind(actor.as_uuid())
                .bind(&kind)
                .fetch_optional(tx.as_mut())
                .await?;
                if let Some(row) = inserted {
                    let title = view(&row)?;
                    let event = audit(org, actor, "job_title.create", &title)?;
                    return Ok(((title, true), vec![event]));
                }
                let row = sqlx::query(
                    "SELECT id, kind, label, grade_rank, active FROM job_titles \
                     WHERE org_id = $1 AND kind = $3 AND lower(label) = lower($2)",
                )
                .bind(org.as_uuid())
                .bind(&label)
                .bind(&kind)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(((view(&row)?, false), vec![]))
            })
        })
        .await
    }

    /// Renames, re-ranks, or (de)activates a title. A title is never deleted:
    /// history and scheduled PROMOTEs keep resolving it.
    pub async fn update_job_title(
        &self,
        principal: Principal,
        id: Uuid,
        request: UpdateJobTitleRequest,
    ) -> Result<JobTitleView, HrError> {
        authorize_manage(&principal)?;
        let label = request
            .label
            .as_deref()
            .map(normalize_job_title_label)
            .transpose()
            .map_err(coded)?;
        rank_in_range(request.grade_rank)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "UPDATE job_titles SET label = COALESCE($3, label), \
                     grade_rank = COALESCE($4, grade_rank), active = COALESCE($5, active) \
                     WHERE org_id = $1 AND id = $2 RETURNING id, kind, label, grade_rank, active",
                )
                .bind(org.as_uuid())
                .bind(id)
                .bind(label)
                .bind(request.grade_rank)
                .bind(request.active)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(|error| match &error {
                    sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                        label_taken()
                    }
                    // job_titles_rank_kind (0266).
                    sqlx::Error::Database(db) if db.code().as_deref() == Some("23514") => {
                        rank_unranked_kind()
                    }
                    _ => HrError::from(error),
                })?
                .ok_or_else(|| {
                    HrError::from_kernel(KernelError::not_found("job title not found"))
                })?;
                let title = view(&row)?;
                let event = audit(org, actor, "job_title.update", &title)?;
                Ok((title, vec![event]))
            })
        })
        .await
    }
}

fn deserialize_enum_16<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["GRADE", "TITLE", "POSITION", "JOB", "JOB_FAMILY"],
    )
}
