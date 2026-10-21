//! Role CRUD. Reads need 권한 관리 조회 over the tenant; writes need 권한 관리
//! 등록·수정 over the tenant, and a non-ops author must already hold every
//! line they add (GR-7, review S14). Every write is a new version; changing
//! the lines of a role with live holders is an access change (reason code +
//! passkey step-up, decision #26).

use console_kernel_core::{OrgId, TenantPhase};
use console_platform_authz::Principal;
use console_platform_authz::access::{Level, load_tenant_phase};
use console_platform_db::{with_audit, with_org_conn};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, audit, read_actor, validate_reason, verify_step_up};
use crate::dto::{LineOut, RoleOut, parse_lines};
use crate::error::{AccessError, AccessResult};
pub use crate::role_requests::{CreateRole, ExpectedVersion, SetStatus, StatusFilter, UpdateRole};
use crate::roles_store::{self as store, VersionFields};

async fn change_mode(tx: &mut Transaction<'_, Postgres>, org: OrgId) -> AccessResult<&'static str> {
    Ok(match load_tenant_phase(tx, org).await? {
        TenantPhase::Setup => "SETUP",
        TenantPhase::Operating => "OPERATING",
    })
}

async fn refuse_delayed_elevation(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    added: &[LineOut],
) -> AccessResult<()> {
    if crate::pending::deadline_for_lines(tx, org, added, &console_kernel_core::SystemClock)
        .await?
        .is_some()
    {
        return Err(AccessError::conflict(
            "held_role_elevation_delayed",
            "권한 적용 대기 시간이 필요합니다. 새 역할을 만들고 권한을 부여해 주세요",
        ));
    }
    Ok(())
}

/// (domain, level) pairs of `new` that `old` does not have.
fn added(old: &[LineOut], new: &[LineOut]) -> Vec<LineOut> {
    new.iter()
        .map(|n| LineOut {
            domain: n.domain,
            levels: n
                .levels
                .iter()
                .filter(|l| {
                    !old.iter()
                        .any(|o| o.domain == n.domain && o.levels.contains(l))
                })
                .copied()
                .collect(),
        })
        .filter(|l| !l.levels.is_empty())
        .collect()
}

pub async fn list(s: &AccessService, p: Principal, q: StatusFilter) -> AccessResult<Vec<RoleOut>> {
    read_actor(s, &p).await?.require_some_access(Level::View)?;
    let roles = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move { store::list(tx, p.org_id, q.status.as_deref()).await })
    })
    .await?;
    Ok(roles)
}

pub async fn get_one(s: &AccessService, p: Principal, id: Uuid) -> AccessResult<RoleOut> {
    read_actor(s, &p).await?.require_some_access(Level::View)?;
    let role = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move { store::get(tx, p.org_id, id, false).await })
    })
    .await?;
    Ok(role)
}

pub async fn versions(
    s: &AccessService,
    p: Principal,
    id: Uuid,
) -> AccessResult<Vec<serde_json::Value>> {
    read_actor(s, &p).await?.require_some_access(Level::View)?;
    let out = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            store::get(tx, p.org_id, id, false).await?;
            store::versions(tx, p.org_id, id).await
        })
    })
    .await?;
    Ok(out)
}

pub async fn create(s: &AccessService, p: Principal, body: CreateRole) -> AccessResult<RoleOut> {
    let lines = parse_lines(&body.lines)?;
    let status = match body.status.as_deref() {
        None | Some("ACTIVE") => "ACTIVE",
        Some("DRAFT") => "DRAFT",
        Some(_) => {
            return Err(AccessError::invalid(
                "validation",
                "status is DRAFT or ACTIVE",
            ));
        }
    };
    let id = Uuid::new_v4();
    let event = audit(&p, "access.role.create", "access_roles", id)?;
    let role = with_audit::<_, _, AccessError>(&s.pool, event, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_access(Level::Edit)?;
            actor.require_holds(&lines, &actor.tenant())?;
            let org = actor.org();
            let f = VersionFields {
                name_ko: &body.name_ko,
                name_en: body.name_en.as_deref(),
                description: body.description.as_deref(),
                status,
                change_mode: change_mode(tx, org).await?,
                reason_code: None,
                reason_note: None,
                lines: &lines,
            };
            store::insert_head(tx, org, id, actor.id(), &f).await?;
            store::insert_version(tx, org, id, 1, actor.id(), &f).await?;
            store::get(tx, org, id, false).await
        })
    })
    .await?;
    Ok(role)
}

pub async fn update(
    s: &AccessService,
    p: Principal,
    id: Uuid,
    body: UpdateRole,
) -> AccessResult<RoleOut> {
    let new_lines = body.lines.as_deref().map(parse_lines).transpose()?;
    let state = s.clone();
    let event = audit(&p, "access.role.update", "access_roles", id)?;
    let role = with_audit::<_, _, AccessError>(&s.pool, event, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_access(Level::Edit)?;
            let org = actor.org();
            let role = store::get(tx, org, id, true).await?;
            if role.version != body.expected_version {
                return Err(AccessError::stale(role.version));
            }
            if role.status == "RETIRED" {
                return Err(AccessError::conflict(
                    "role_not_active",
                    "a retired role is kept as history",
                ));
            }
            let lines = new_lines.unwrap_or_else(|| role.lines.clone());
            let added = added(&role.lines, &lines);
            actor.require_holds(&added, &actor.tenant())?;
            let holders = if lines == role.lines {
                Vec::new()
            } else {
                store::live_holders(tx, org, id).await?
            };
            if !holders.is_empty() {
                refuse_delayed_elevation(tx, org, &added).await?;
                let code = body.reason_code.as_deref().ok_or_else(|| {
                    AccessError::invalid(
                        "reason_code_invalid",
                        "a reason is required to change a held role",
                    )
                })?;
                validate_reason(tx, org, code, body.reason_note.as_deref()).await?;
                verify_step_up(&state, &p, body.step_up).await?;
            } else if let Some(code) = body.reason_code.as_deref() {
                validate_reason(tx, org, code, body.reason_note.as_deref()).await?;
            }
            let name_en = body.name_en.unwrap_or(role.name_en.clone());
            let description = body.description.unwrap_or(role.description.clone());
            let f = VersionFields {
                name_ko: body.name_ko.as_deref().unwrap_or(&role.name_ko),
                name_en: name_en.as_deref(),
                description: description.as_deref(),
                status: &role.status,
                change_mode: change_mode(tx, org).await?,
                reason_code: body.reason_code.as_deref(),
                reason_note: body.reason_note.as_deref(),
                lines: &lines,
            };
            let version = role.version + 1;
            store::update_head(tx, org, id, version, &f).await?;
            store::insert_version(tx, org, id, version, actor.id(), &f).await?;
            let mut out = store::get(tx, org, id, false).await?;
            out.holders_affected = Some(holders);
            Ok(out)
        })
    })
    .await?;
    Ok(role)
}

pub async fn set_status(
    s: &AccessService,
    p: Principal,
    id: Uuid,
    body: SetStatus,
) -> AccessResult<RoleOut> {
    let event = audit(&p, "access.role.status", "access_roles", id)?;
    let role = with_audit::<_, _, AccessError>(&s.pool, event, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_access(Level::Edit)?;
            let org = actor.org();
            let role = store::get(tx, org, id, true).await?;
            if role.version != body.expected_version {
                return Err(AccessError::stale(role.version));
            }
            match (role.status.as_str(), body.status.as_str()) {
                ("DRAFT", "ACTIVE") => {
                    actor.require_holds(&role.lines, &actor.tenant())?;
                    if !store::live_holders(tx, org, id).await?.is_empty() {
                        refuse_delayed_elevation(tx, org, &role.lines).await?;
                    }
                }
                ("ACTIVE", "RETIRED") => {
                    let code = body.reason_code.as_deref().ok_or_else(|| {
                        AccessError::invalid(
                            "reason_code_invalid",
                            "a reason is required to retire a role",
                        )
                    })?;
                    validate_reason(tx, org, code, body.reason_note.as_deref()).await?;
                    if !store::live_holders(tx, org, id).await?.is_empty() {
                        return Err(AccessError::conflict(
                            "role_has_active_grants",
                            "revoke the role's live grants before retiring it",
                        ));
                    }
                }
                _ => {
                    return Err(AccessError::conflict(
                        "invalid_transition",
                        "DRAFT → ACTIVE and ACTIVE → RETIRED only",
                    ));
                }
            }
            let f = VersionFields {
                name_ko: &role.name_ko,
                name_en: role.name_en.as_deref(),
                description: role.description.as_deref(),
                status: &body.status,
                change_mode: change_mode(tx, org).await?,
                reason_code: body.reason_code.as_deref(),
                reason_note: body.reason_note.as_deref(),
                lines: &role.lines,
            };
            let version = role.version + 1;
            store::update_head(tx, org, id, version, &f).await?;
            store::insert_version(tx, org, id, version, actor.id(), &f).await?;
            store::get(tx, org, id, false).await
        })
    })
    .await?;
    Ok(role)
}

pub async fn delete(
    s: &AccessService,
    p: Principal,
    id: Uuid,
    q: ExpectedVersion,
) -> AccessResult<()> {
    let event = audit(&p, "access.role.delete", "access_roles", id)?;
    with_audit::<_, _, AccessError>(&s.pool, event, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_access(Level::Edit)?;
            let role = store::get(tx, actor.org(), id, true).await?;
            if role.version != q.expected_version {
                return Err(AccessError::stale(role.version));
            }
            if role.status != "DRAFT" {
                return Err(AccessError::conflict(
                    "role_not_draft",
                    "only a never-active draft is deleted; retire an active role",
                ));
            }
            store::delete_draft(tx, actor.org(), id).await
        })
    })
    .await?;
    Ok(())
}
