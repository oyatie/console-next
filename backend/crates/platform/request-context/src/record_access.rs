//! Current record authority shared by outcome and conflict metadata readers.
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::access::model::union_branches;
use console_platform_authz::access::{AccessSlice, NodeKind, load_access_subject, scope_path};
use console_platform_authz::cedar_pbac::actions::command_outcome;
use console_platform_authz::{
    Action, Feature, PermissionLevel, Principal, authorize, authorize_capability,
    authorize_org_wide, permission_for,
};
use console_platform_db::{DbError, with_org_conn};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "record_access/access.rs"]
mod access;
#[path = "record_access/hr.rs"]
mod hr;
#[path = "record_access/observed.rs"]
mod observed;
#[path = "record_access/operation.rs"]
mod operation;
#[path = "record_access/outcome.rs"]
pub mod outcome;
#[path = "record_access/support.rs"]
mod support;

pub async fn may_read(
    pool: &PgPool,
    principal: &Principal,
    kind: &str,
    id: &str,
    _branch: Option<Uuid>,
) -> bool {
    if hr::handles(kind) {
        return hr::may_read(pool, principal, kind, id).await;
    }
    let feature = match kind {
        "employee" => Feature::EmployeeDirectoryRead,
        "org_unit"
        | "legal_entity"
        | "business_registration"
        | "workplace"
        | "org_change_request"
        | "tenant" => Feature::OrgChangeRead,
        "period_lock" => Feature::PeriodLockManage,
        "work_order_settlement" => Feature::WorkOrderReadAll,
        "support_ticket" | "support_ticket_acceptance" | "support_ticket_comment" => Feature::Login,
        "equipment_3r_unit" | "equipment_3r_case" | "equipment_3r_disposition" => {
            Feature::Equipment3rObserve
        }
        "user" => Feature::UserManage,
        "policy_role"
        | "access_role"
        | "access_roles"
        | "access_grant_receipts"
        | "access_grant" => Feature::RoleManage,
        _ => return false,
    };
    let org = principal.org_id;
    let actor = *principal.user_id.as_uuid();
    let Ok(node) = Uuid::parse_str(id) else {
        return false;
    };
    let kind = kind.to_owned();
    let p = principal.clone();
    let readable=with_org_conn::<_,_,DbError>(pool,org,move |tx| Box::pin(async move {
        if matches!(kind.as_str(), "support_ticket" | "support_ticket_acceptance" | "support_ticket_comment") {
            return support::may_read(tx, &p, &kind, node).await;
        }
        if matches!(kind.as_str(), "period_lock" | "org_change_request" | "equipment_3r_unit" | "equipment_3r_case" | "equipment_3r_disposition" | "work_order_settlement") {
            return observed::may_read(tx, &p, &kind, node).await;
        }
        if matches!(kind.as_str(), "access_role" | "access_roles" | "access_grant" | "access_grant_receipts") {
            return access::may_read(tx, &p, &kind, node).await;
        }
        if kind == "user" {
            if authorize_capability(&p, Action::new(Feature::UserManage)).is_err() {
                return Ok(false);
            }
            let branches = match account_scope(&p) {
                BranchScope::All => None,
                BranchScope::Branches(branches) => Some(branches.into_iter().map(|id| *id.as_uuid()).collect::<Vec<_>>()),
            };
            return Ok(sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM users u WHERE u.org_id=$1 AND u.id=$2
                  AND ($3::uuid[] IS NULL OR EXISTS (
                    SELECT 1 FROM user_branches b WHERE b.org_id=u.org_id
                      AND b.user_id=u.id AND b.branch_id=ANY($3))))",
            ).bind(org.as_uuid()).bind(node).bind(branches).fetch_one(tx.as_mut()).await?);
        }
        // Entity readers can hold a legal-entity scope without an all-branch grant.
        let path=match (kind.as_str(),node) {
            ("legal_entity",id)=>{
                let le:Option<Uuid>=sqlx::query_scalar("SELECT id FROM legal_entities WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
                le.map(|le|scope_path(org,NodeKind::LegalEntity,Some(le),Some(le)))
            },
            ("workplace",id)=>{
                let le:Option<Uuid>=sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
                le.map(|le|scope_path(org,NodeKind::Workplace,Some(id),Some(le)))
            },
            ("business_registration",id)=>{
                let le:Option<Uuid>=sqlx::query_scalar("SELECT legal_entity_id FROM business_registrations WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
                le.map(|le|scope_path(org,NodeKind::LegalEntity,Some(le),Some(le)))
            },
            _=>None,
        };
        if matches!(kind.as_str(), "legal_entity" | "workplace" | "business_registration") && path.is_none() {
            return Ok(false);
        }
        let exists_sql = match kind.as_str() {
            "org_unit" => Some("SELECT EXISTS (SELECT 1 FROM organizations WHERE id=$1 AND id=$2) OR EXISTS (SELECT 1 FROM org_units u JOIN LATERAL (SELECT attributes FROM org_unit_revisions r WHERE r.org_id=u.org_id AND r.org_unit_id=u.id ORDER BY r.version DESC LIMIT 1) head ON true WHERE u.org_id=$1 AND u.id=$2 AND head.attributes->>'kind' IN ('site','department','team'))"),
            "tenant" => Some("SELECT EXISTS (SELECT 1 FROM organizations WHERE id=$1 AND id=$2)"),
            "policy_role" => Some("SELECT EXISTS (SELECT 1 FROM policy_roles WHERE org_id=$1 AND id=$2)"),
            _ => None,
        };
        if let Some(sql) = exists_sql {
            let exists: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).bind(org.as_uuid()).bind(node).fetch_one(tx.as_mut()).await?;
            if !exists { return Ok(false); }
        }
        if let Some(path)=path {
            if !matches!(p.access_scope.level,console_kernel_core::AccessScopeLevel::Org|console_kernel_core::AccessScopeLevel::Group) {
                let branches:Vec<Uuid>=match kind.as_str() {
                    "workplace"=>sqlx::query_scalar("SELECT default_branch_id FROM workplaces WHERE org_id=$1 AND id=$2 AND default_branch_id IS NOT NULL").bind(org.as_uuid()).bind(node).fetch_all(tx.as_mut()).await?,
                    "legal_entity"=>sqlx::query_scalar("SELECT default_branch_id FROM workplaces WHERE org_id=$1 AND legal_entity_id=$2 AND default_branch_id IS NOT NULL").bind(org.as_uuid()).bind(node).fetch_all(tx.as_mut()).await?,
                    "business_registration"=>sqlx::query_scalar("SELECT w.default_branch_id FROM workplaces w JOIN business_registrations r ON r.org_id=w.org_id AND r.legal_entity_id=w.legal_entity_id WHERE r.org_id=$1 AND r.id=$2 AND w.default_branch_id IS NOT NULL").bind(org.as_uuid()).bind(node).fetch_all(tx.as_mut()).await?,
                    _=>Vec::new(),
                };
                if branches.is_empty() || branches.iter().any(|id|!p.branch_scope.allows(BranchId::from_uuid(*id))) {return Ok(false);}
            }
            let subject=load_access_subject(tx,org,actor,time::OffsetDateTime::now_utc()).await
                .map_err(|e|DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?;
            if !subject.grants.is_empty() || subject.is_ops {
                return Ok(AccessSlice::compile(&subject).ok().is_some_and(|slice|slice.allows(feature.as_str(),&path).unwrap_or(false)));
            }
        }
        let branch=if kind=="employee" {
            let Some(home_branch) = sqlx::query_scalar::<_,Option<Uuid>>("SELECT b.id FROM employees e LEFT JOIN branches b ON b.org_id=e.org_id AND b.id=e.home_branch_id AND b.deactivated_at IS NULL WHERE e.org_id=$1 AND e.id=$2")
                .bind(org.as_uuid()).bind(node).fetch_optional(tx.as_mut()).await? else { return Ok(false) };
            home_branch
        } else { None };
        Ok(match branch {
            Some(id)=>authorize(&p,Action::new(feature),BranchId::from_uuid(id)).is_ok(),
            None=>authorize_org_wide(&p,Action::new(feature)).is_ok(),
        })
    })).await.unwrap_or(false);
    command_outcome::decide(
        &principal.user_id.to_string(),
        &principal.org_id.to_string(),
        false,
        readable,
    )
    .unwrap_or(false)
}
pub async fn all_readable(pool: &PgPool, p: &Principal, touched: &Value) -> bool {
    let Some(items) = touched.as_array().filter(|items| !items.is_empty()) else {
        return false;
    };
    let has_employee = items
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("employee"));
    for item in items {
        let (Some(kind), Some(id)) = (
            item.get("type").and_then(Value::as_str),
            item.get("id").and_then(Value::as_str),
        ) else {
            return false;
        };
        if kind == "employee_lifecycle_batch" {
            if !has_employee || Uuid::parse_str(id).is_err() {
                return false;
            }
            continue;
        }
        let branch = item
            .get("branch_id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok());
        if matches!(
            kind,
            "logistics_asn" | "logistics_fulfillment" | "logistics_shipment"
        ) {
            if !operation::may_read_saved(pool, p, item).await {
                return false;
            }
            continue;
        }
        if !may_read(pool, p, kind, id, branch).await {
            return false;
        }
    }
    true
}

fn account_scope(p: &Principal) -> BranchScope {
    let mut scope = if p
        .roles
        .iter()
        .any(|role| permission_for(*role, Feature::UserManage) == PermissionLevel::Allow)
    {
        p.branch_scope.clone()
    } else {
        BranchScope::none()
    };
    for grant in p.effective_feature_grants.iter().filter(|grant| {
        grant.feature == Feature::UserManage && grant.permission == PermissionLevel::Allow
    }) {
        scope = union_branches(&scope, &grant.branch_scope);
    }
    scope
}

/// Apply the same sensitive-field omission as lifecycle history after access changes.
pub fn mask_result(p: &Principal, result: &mut Value) {
    if authorize_org_wide(p, Action::new(Feature::EmployeeDirectoryManage)).is_ok() {
        return;
    }
    mask_lifecycle(result);
}

pub async fn mask_saved_result(pool: &PgPool, p: &Principal, result: &mut Value) {
    mask_result(p, result);
    operation::mask_entities(pool, p, result).await;
    hr::mask_exit_results(pool, p, result).await;
}
fn mask_lifecycle(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(mask_lifecycle),
        Value::Object(fields) => {
            if fields.contains_key("employee_id")
                && fields.contains_key("event_type")
                && fields.contains_key("to_status")
            {
                fields.remove("leave_type");
                fields.remove("cancel_reason");
                if let Some(Value::Object(facts)) = fields.get_mut("group_transfer") {
                    facts.remove("consent_evidence_ref");
                    facts.remove("succession_evidence_ref");
                }
            }
            fields.values_mut().for_each(mask_lifecycle);
        }
        _ => {}
    }
}

fn mask_entity_fields(
    value: &mut Value,
    allowed: &std::collections::BTreeMap<(&'static str, Uuid), bool>,
    inherited: Option<bool>,
) {
    match value {
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| mask_entity_fields(value, allowed, inherited)),
        Value::Object(fields) => {
            let personal = operation::subject(fields)
                .map(|key| allowed.get(&key).copied().unwrap_or(false) && inherited.unwrap_or(true))
                .or(inherited);
            if personal == Some(false) {
                for key in [
                    "representatives",
                    "directors",
                    "co_owners",
                    "representative_name",
                    "mobile",
                    "email",
                ] {
                    if let Some(field) = fields.get_mut(key) {
                        *field = Value::Null;
                    }
                }
                if let Some(field) = fields.get_mut("can_manage") {
                    *field = Value::Bool(false);
                }
            }
            fields
                .values_mut()
                .for_each(|value| mask_entity_fields(value, allowed, personal));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "record_access/access_tests.rs"]
mod access_tests;

#[cfg(test)]
#[path = "record_access/receipt_tests.rs"]
mod receipt_tests;

#[cfg(test)]
#[path = "record_access/employee_tests.rs"]
mod employee_tests;

#[cfg(test)]
#[path = "record_access/existence_tests.rs"]
mod existence_tests;
