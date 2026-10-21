//! An unused department can be erased; a used one is retired with history kept.
//! End options return the permitted action and a typed reason for refusals.

use console_entity_application::{Actor, OrgSetupOp, OrgSetupReceipt};
use console_entity_domain::Refusal;
use console_kernel_core::{ChangeMode, TenantPhase};
use console_platform_db::{with_audits, with_org_conn};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::org_batch::BatchMode;
use crate::org_tree;
use crate::org_units::OrgUnitSetupWritePort;
use crate::org_usage::{department, dissolve_refusal, erase_refusal, refuse, usage};
use crate::{Admitted, PgEntityError, PgEntityStore, audit, read_phase};

/// One way to end the unit: offered, or refused with a stable code.
#[derive(Debug, Clone, Serialize)]
pub struct EndOffer {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<&'static str>,
}

impl EndOffer {
    pub(crate) fn from(refusal: Option<&'static str>) -> Self {
        Self {
            allowed: refusal.is_none(),
            refusal,
        }
    }
}

/// `GET /org-structure/units/{id}/end-options`.
#[derive(Debug, Clone, Serialize)]
pub struct OrgUnitEndOptions {
    pub org_unit_id: Uuid,
    pub name: String,
    pub version: i64,
    pub phase: &'static str,
    /// 삭제: erase the unit and its sub-부서 (never used).
    pub delete: EndOffer,
    /// 폐지: a dissolved revision, history kept (used).
    pub dissolve: EndOffer,
    /// People placed in it or under it now (scheduled moves in count).
    pub members: i64,
    /// People ever placed in it or under it, or moved through it.
    pub people_ever: i64,
    /// The unit and its active sub-부서.
    pub units: i64,
    /// The open org change that holds the unit (UX-R3 org-16), named as its blocker.
    pub held_by: Option<HeldBy>,
}

/// An open org change, by id and code.
#[derive(Debug, Clone, Serialize)]
pub struct HeldBy {
    pub id: Uuid,
    pub code: String,
}

/// `POST /org-structure/units/{id}/erase`.
#[derive(Debug, Clone, Serialize)]
pub struct OrgUnitErased {
    pub id: Uuid,
    pub erased: i64,
    pub change_mode: String,
}

impl PgEntityStore {
    /// Which way the 부서 `id` ends (삭제 or 폐지), and why the other is not offered.
    ///
    /// # Errors
    /// `org_unit_not_found`, `site_is_a_workplace`, or database faults.
    pub async fn org_unit_end_options(
        &self,
        actor: &Actor,
        id: Uuid,
        port: std::sync::Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgUnitEndOptions, PgEntityError> {
        let org = actor.org;
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let phase = read_phase(tx, false).await?;
                let head = department(tx, id).await?;
                let u = usage(tx, id).await?;
                let routed = phase == TenantPhase::Operating
                    && port
                        .org_changes_routed(tx, org)
                        .await
                        .map_err(Refusal::from)?;
                Ok(OrgUnitEndOptions {
                    org_unit_id: id,
                    name: head.name().to_owned(),
                    version: head.version,
                    phase: phase.as_str(),
                    delete: EndOffer::from(erase_refusal(&u)),
                    dissolve: EndOffer::from(dissolve_refusal(&u, routed)),
                    members: u.members,
                    people_ever: u.people_ever,
                    units: i64::try_from(u.units.len()).unwrap_or(i64::MAX),
                    held_by: u.held_by.map(|(id, code)| HeldBy { id, code }),
                })
            })
        })
        .await
    }

    /// Erase a 부서 that was never used, with its sub-부서, in either phase.
    ///
    /// # Errors
    /// `org_unit_not_found`, `site_is_a_workplace`, `stale_revision`,
    /// `org_unit_has_people_history` / `org_unit_has_history` (remedy
    /// `dissolve_instead`), `org_unit_change_open`, or database faults.
    pub async fn erase_org_unit(
        &self,
        actor: &Actor,
        id: Uuid,
        expected_version: i32,
    ) -> Result<OrgUnitErased, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "id": id, "expected_version": expected_version });
                if let Some(done) = claim(tx, &actor, "org_unit.erase", request).await? {
                    let erased = OrgUnitErased {
                        id,
                        erased: done.count.unwrap_or(0),
                        change_mode: done.change_mode.unwrap_or_default(),
                    };
                    return Ok((erased, vec![]));
                }
                let phase = read_phase(tx, true).await?;
                let admitted = Admitted {
                    phase,
                    mode: if phase == TenantPhase::Setup {
                        ChangeMode::Setup
                    } else {
                        ChangeMode::Governed
                    },
                };
                let mut lock = org_tree::subtree(tx, &[id]).await?;
                lock.push(id);
                org_tree::lock_units(tx, &lock).await?;
                let head = department(tx, id).await?;
                let current = i32::try_from(head.version).unwrap_or(i32::MAX);
                if current != expected_version {
                    return Err(Refusal::stale_revision(expected_version, current).into());
                }
                let u = usage(tx, id).await?;
                if let Some(code) = erase_refusal(&u) {
                    return Err(refuse(code));
                }
                let mut events = Vec::with_capacity(u.units.len());
                for unit in &u.units {
                    let h = org_tree::head(tx, *unit)
                        .await?
                        .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
                    events.push(audit(
                        &actor,
                        "org_unit.erase",
                        "org_unit",
                        *unit,
                        admitted,
                        json!({ "erased_with": id, "name": h.attributes["name"],
                                "parent_id": h.attributes["parent_id"], "code": h.attributes["code"],
                                "version": h.version }),
                    )?);
                }
                sqlx::query("SELECT org_unit_erase($1)")
                    .bind(&u.units)
                    .execute(tx.as_mut())
                    .await?;
                let erased = i64::try_from(u.units.len()).unwrap_or(i64::MAX);
                let outcome = Outcome {
                    target: Some(id),
                    change_mode: Some(admitted.mode.as_str().into()),
                    count: Some(erased),
                };
                finish(tx, &actor, &outcome).await?;
                let out = OrgUnitErased {
                    id,
                    erased,
                    change_mode: admitted.mode.as_str().into(),
                };
                Ok((out, events))
            })
        })
        .await
    }

    /// 폐지 a used 부서 and its empty sub-부서 now, in either phase (after 운영
    /// 시작 recorded GOVERNED; [`admit_direct`] refuses it while org changes
    /// are routed, for a never-used unit, or while people are in it).
    ///
    /// # Errors
    /// As [`admit_direct`], `stale_revision`, `site_is_a_workplace`.
    pub async fn dissolve_org_unit(
        &self,
        actor: &Actor,
        id: Uuid,
        expected_version: i32,
        port: std::sync::Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let request = json!({ "id": id, "expected_version": expected_version });
        let op = OrgSetupOp::Dissolve {
            org_unit_id: Some(id),
            expected_version: Some(expected_version),
        };
        self.run_batch(
            actor,
            "org_unit.dissolve",
            request,
            vec![op],
            BatchMode::Direct,
            port,
        )
        .await
    }

    /// Set a 부서's 부서장 and 부서 코드 now (the full new values; `None`
    /// clears), in either phase.
    ///
    /// # Errors
    /// As [`admit_direct`], `stale_revision`, `code_taken`, `head_unavailable`.
    pub async fn set_org_unit_details(
        &self,
        actor: &Actor,
        id: Uuid,
        expected_version: i32,
        code: Option<String>,
        head_employee_id: Option<Uuid>,
        port: std::sync::Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let request = json!({ "id": id, "expected_version": expected_version, "code": code,
                              "head_employee_id": head_employee_id });
        let op = OrgSetupOp::SetDetails {
            org_unit_id: Some(id),
            expected_version: Some(expected_version),
            code,
            head_employee_id,
        };
        self.run_batch(
            actor,
            "org_unit.details",
            request,
            vec![op],
            BatchMode::Direct,
            port,
        )
        .await
    }
}
