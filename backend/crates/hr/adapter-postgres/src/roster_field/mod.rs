//! Fields a tenant adds to its personnel card: the definitions (list, add,
//! change). A definition has a label, a value type and a card section, both
//! fixed once added, and is retired rather than deleted. First release: the
//! 인적사항 and 재직·배치 sections, values read by managers only, at most
//! [`ACTIVE_LIMIT`] active fields. A field is never a pay item.

use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use sqlx::types::Json;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{authorize_hr_org_wide, authorize_hr_scoped};
use crate::lifecycle::title_reason::coded;
use crate::{HrError, HrService};

mod rules;
pub use rules::{RosterFieldChoice, RosterFieldChoiceInput};

/// Active fields per tenant; a retired field frees its place.
pub const ACTIVE_LIMIT: i64 = 30;
macro_rules! columns {
    () => {
        "id, label, value_type, section, visibility, choices, active"
    };
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RosterFieldView {
    pub id: Uuid,
    pub label: String,
    /// TEXT, INTEGER, DECIMAL, DATE or CHOICE.
    pub value_type: String,
    /// PERSONAL (인적사항) or JOB (재직·배치).
    pub section: String,
    /// MANAGERS: values are read by managers, not by the person themselves.
    pub visibility: String,
    pub choices: Vec<RosterFieldChoice>,
    pub active: bool,
}

#[derive(Debug, Serialize)]
pub struct RosterFieldList {
    pub items: Vec<RosterFieldView>,
    /// The caller may add or change fields (`roster_field_manage`).
    pub can_manage: bool,
    pub active_limit: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRosterFieldRequest {
    pub label: String,
    #[serde(deserialize_with = "value_type")]
    pub value_type: String,
    #[serde(deserialize_with = "section")]
    pub section: String,
    #[serde(default)]
    pub choices: Vec<RosterFieldChoiceInput>,
}

/// A change to one field; omitted parts stay. Type and section never change.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRosterFieldRequest {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub choices: Option<Vec<RosterFieldChoiceInput>>,
    #[serde(default)]
    pub active: Option<bool>,
}

/// Cedar's `roster_field_manage`, fail-closed. The fact: a tenant-wide
/// `roster_field_manage` or HR 등록·수정 (`employee_directory_manage`); a
/// 법인/사업장-scoped grant never reaches the tenant-wide definitions.
fn authorize_manage(principal: &Principal) -> Result<(), HrError> {
    let holds = [Feature::RosterFieldManage, Feature::EmployeeDirectoryManage]
        .into_iter()
        .any(|feature| authorize_hr_org_wide(principal, feature).is_ok());
    let facts = Facts::new().bool("actor_holds_permission", holds);
    let resource = AuthorizationResource::org_wide(principal.org_id, "roster_field");
    enforce_action(principal, Feature::RosterFieldManage, resource, &facts)
        .map_err(HrError::from_kernel)
}

fn view(row: &sqlx::postgres::PgRow) -> Result<RosterFieldView, HrError> {
    let Json(choices): Json<Vec<RosterFieldChoice>> = row.try_get("choices")?;
    Ok(RosterFieldView {
        id: row.try_get("id")?,
        label: row.try_get("label")?,
        value_type: row.try_get("value_type")?,
        section: row.try_get("section")?,
        visibility: row.try_get("visibility")?,
        choices,
        active: row.try_get("active")?,
    })
}

fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    field: &RosterFieldView,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "roster_field",
        field.id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(json!(field))))
}

fn label_taken(error: sqlx::Error) -> HrError {
    match &error {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => coded(
            KernelError::conflict("another field already has this label")
                .with_code("roster_field_label_taken")
                .with_field("label"),
        ),
        _ => HrError::from(error),
    }
}

/// Serializes adds and reactivations per tenant, then refuses one past the limit.
async fn room(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: OrgId) -> Result<(), HrError> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtext('roster_field_definitions'), hashtext($1::text))",
    )
    .bind(org.as_uuid())
    .execute(tx.as_mut())
    .await?;
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM roster_field_definitions WHERE org_id = $1 AND active",
    )
    .bind(org.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    if active >= ACTIVE_LIMIT {
        return Err(coded(
            KernelError::conflict("the tenant has the most active fields allowed")
                .with_code("roster_field_limit"),
        ));
    }
    Ok(())
}

impl HrService {
    /// Every field of the tenant, active first, in the order they were added.
    pub async fn roster_fields(&self, principal: Principal) -> Result<RosterFieldList, HrError> {
        authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
        let (org, can_manage) = (principal.org_id, authorize_manage(&principal).is_ok());
        let items = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM roster_field_definitions WHERE org_id = $1 ORDER BY active DESC, created_at, id"
                ))
                .bind(org.as_uuid())
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(view)
                .collect::<Result<Vec<_>, HrError>>()
            })
        })
        .await?;
        Ok(RosterFieldList {
            items,
            can_manage,
            active_limit: ACTIVE_LIMIT,
        })
    }

    /// Adds a field. A label the tenant already has (ignoring case, retired
    /// fields included) is refused, as is one past [`ACTIVE_LIMIT`].
    pub async fn create_roster_field(
        &self,
        principal: Principal,
        request: CreateRosterFieldRequest,
    ) -> Result<RosterFieldView, HrError> {
        authorize_manage(&principal)?;
        let label = rules::label(&request.label)?;
        let choices = rules::choices(&request.value_type, &[], request.choices)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                room(tx, org).await?;
                let row = sqlx::query(concat!(
                    "INSERT INTO roster_field_definitions (org_id, label, value_type, section, choices, created_by) \
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ",
                    columns!()
                ))
                .bind(org.as_uuid())
                .bind(&label)
                .bind(&request.value_type)
                .bind(&request.section)
                .bind(Json(&choices))
                .bind(actor.as_uuid())
                .fetch_one(tx.as_mut())
                .await
                .map_err(label_taken)?;
                let field = view(&row)?;
                let event = audit(org, actor, "roster_field.create", &field)?;
                Ok((field, vec![event]))
            })
        })
        .await
    }

    /// Renames a field, relabels or adds options, or retires or restores it.
    pub async fn update_roster_field(
        &self,
        principal: Principal,
        id: Uuid,
        request: UpdateRosterFieldRequest,
    ) -> Result<RosterFieldView, HrError> {
        authorize_manage(&principal)?;
        let label = request.label.as_deref().map(rules::label).transpose()?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let current = sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM roster_field_definitions WHERE org_id = $1 AND id = $2 FOR UPDATE"
                ))
                .bind(org.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    coded(KernelError::not_found("field not found").with_code("roster_field_not_found"))
                })?;
                let current = view(&current)?;
                let choices = match request.choices {
                    Some(sent) => rules::choices(&current.value_type, &current.choices, sent)?,
                    None => current.choices.clone(),
                };
                // A request that changes nothing writes nothing and records no event.
                if label.as_ref().is_none_or(|l| *l == current.label)
                    && choices == current.choices
                    && request.active.is_none_or(|a| a == current.active)
                {
                    return Ok((current, vec![]));
                }
                if request.active == Some(true) && !current.active {
                    room(tx, org).await?;
                }
                let row = sqlx::query(concat!(
                    "UPDATE roster_field_definitions SET label = COALESCE($3, label), choices = $4, \
                     active = COALESCE($5, active) WHERE org_id = $1 AND id = $2 RETURNING ",
                    columns!()
                ))
                .bind(org.as_uuid())
                .bind(id)
                .bind(label)
                .bind(Json(&choices))
                .bind(request.active)
                .fetch_one(tx.as_mut())
                .await
                .map_err(label_taken)?;
                let field = view(&row)?;
                let event = audit(org, actor, "roster_field.update", &field)?;
                Ok((field, vec![event]))
            })
        })
        .await
    }
}

fn value_type<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    console_kernel_core::validation::deserialize_enum_string(
        d,
        &["TEXT", "INTEGER", "DECIMAL", "DATE", "CHOICE"],
    )
}

fn section<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    console_kernel_core::validation::deserialize_enum_string(d, &["PERSONAL", "JOB"])
}
