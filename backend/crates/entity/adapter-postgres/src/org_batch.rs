//! Setup 부서 batches (MR-12; design OM §3.2-§3.5, decisions #18, #20): one
//! transaction applies every op through the canonical OrgUnit owner, or none.
//! Each change to an existing unit is pinned to the version the client read
//! (a per-op 409 names the op and the unit), and each touched unit's
//! before-image is kept in `org_setup_batches`, so the batch can be undone
//! until 운영 시작 (`org_batch_undo`). After go-live `admit` refuses with
//! `phase_not_setup` / `submit_org_change`: changes then go through a
//! governed org change.

use std::collections::HashMap;
use std::sync::Arc;

use console_entity_application::{Actor, OrgSetupOp, OrgSetupReceipt, OrgSetupUnit};
use console_entity_domain::{FieldIssue, Refusal};
use console_kernel_core::{AuditEvent, WriteClass};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::command::{Outcome, claim, command_id, finish};
use crate::org_batch_undo::replay;
use crate::org_tree::{self, Head};
use crate::org_units::{OrgUnitSetupWritePort, port_refusal};
use crate::{Admitted, PgEntityError, PgEntityStore, Tx, admit, audit, today_kst};

/// a request-size guard, not a tenant policy; one batch is one
/// transaction (OM C12). The P2b group has ≈ 420 부서 in all.
pub(crate) const MAX_OPS: usize = 1000;

/// How a batch was asked for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchMode {
    /// `POST /org-structure/batches`: fields named `ops[i].…`.
    Setup,
    /// A single-unit setup route: fields named bare (legacy clients).
    Unit,
    /// A 부서 write that applies at once in either phase (CRUD: 폐지,
    /// 부서장 · 코드), recorded GOVERNED after 운영 시작 and refused while
    /// the tenant routes org changes (`crate::org_usage::admit_direct`).
    Direct,
}

/// A unit as it was before the batch first touched it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Before {
    pub version: i64,
    pub attributes: Value,
}

/// One unit written by one op.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Step {
    pub op_index: usize,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub client_ref: Option<String>,
    pub org_unit_id: Uuid,
    /// `None`: the batch created the unit.
    pub before: Option<Before>,
    pub after_version: i64,
}

impl Step {
    pub fn unit(&self) -> OrgSetupUnit {
        OrgSetupUnit {
            op_index: self.op_index,
            client_ref: self.client_ref.clone(),
            org_unit_id: self.org_unit_id,
            version: self.after_version,
        }
    }
}

/// What every op of one batch (or undo) shares.
pub(crate) struct Run<'a> {
    pub actor: &'a Actor,
    pub port: &'a dyn OrgUnitSetupWritePort,
    pub admitted: Admitted,
    pub today: time::Date,
    pub batch: Uuid,
    /// The single-unit routes name fields without the `ops[i].` prefix.
    pub legacy: bool,
    pub refs: HashMap<String, Uuid>,
    pub steps: Vec<Step>,
    pub events: Vec<AuditEvent>,
}

impl Run<'_> {
    pub fn field(&self, i: usize, name: &str) -> String {
        if self.legacy {
            name.to_owned()
        } else {
            format!("ops[{i}].{name}")
        }
    }

    pub fn refuse(&self, i: usize, name: &str, code: &'static str) -> PgEntityError {
        Refusal::field(self.field(i, name), code).into()
    }

    /// 409 `stale_revision` unless the client read the unit at its current
    /// version. The single-unit routes may omit the pin (legacy clients).
    pub fn pinned(
        &self,
        i: usize,
        id: Uuid,
        head: &Head,
        expected: Option<i32>,
    ) -> Result<(), PgEntityError> {
        let current = i32::try_from(head.version).unwrap_or(i32::MAX);
        match expected {
            None if self.legacy => Ok(()),
            None => Err(self.refuse(i, "expected_version", "required")),
            Some(v) if v == current => Ok(()),
            Some(v) => {
                let mut refusal = Refusal::stale_revision(v, current);
                refusal.message =
                    format!("org unit {id} changed since version {v}; it is at version {current}");
                refusal.fields = vec![FieldIssue {
                    field: self.field(i, "expected_version"),
                    code: "stale_revision",
                }];
                Err(refusal.into())
            }
        }
    }

    /// Write `attributes` as the next revision of `unit` (a new unit when
    /// `None`) and record the step. A unit that lands in another 사업장 takes
    /// its people's 사업장 placement with it.
    pub async fn write(
        &mut self,
        tx: &mut Tx<'_>,
        i: usize,
        client_ref: Option<String>,
        unit: Option<(Uuid, Head)>,
        mut attributes: Value,
        action: &str,
    ) -> Result<Uuid, PgEntityError> {
        attributes["effective_from"] = json!(self.today.to_string());
        let (id, before) = unit.map_or((None, None), |(id, head)| (Some(id), Some(head)));
        let reparented = before
            .as_ref()
            .is_some_and(|h| h.attributes["parent_id"] != attributes["parent_id"]);
        let from = match id {
            Some(id) if reparented => org_tree::workplace_of(tx, id).await?,
            _ => None,
        };
        let written = self
            .port
            .write(
                tx,
                self.actor.org,
                self.actor.user,
                Uuid::new_v4(),
                id,
                attributes.clone(),
            )
            .await
            .map_err(port_refusal)?;
        if let Some(from) = from
            && let Some(to) = org_tree::workplace_of(tx, written).await?
            && to != from
        {
            let units = org_tree::subtree(tx, &[written]).await?;
            org_tree::rebind_members(tx, self.actor, Uuid::new_v4(), &units, from, to).await?;
        }
        let after = org_tree::head(tx, written).await?.map_or(1, |h| h.version);
        self.events.push(audit(
            self.actor,
            action,
            "org_unit",
            written,
            self.admitted,
            json!({ "batch_id": self.batch, "name": attributes["name"], "parent_id": attributes["parent_id"],
                    "status": attributes["status"], "code": attributes["code"],
                    "head_employee_id": attributes["head_employee_id"], "version": after }),
        )?);
        self.steps.push(Step {
            op_index: i,
            client_ref,
            org_unit_id: written,
            before: before.map(|h| Before {
                version: h.version,
                attributes: h.attributes,
            }),
            after_version: after,
        });
        Ok(written)
    }

    /// Record the batch row and its audit event; the receipt to return.
    pub async fn record(
        mut self,
        tx: &mut Tx<'_>,
        kind: &str,
        undoes: Option<Uuid>,
    ) -> Result<(OrgSetupReceipt, Vec<AuditEvent>), PgEntityError> {
        sqlx::query(
            "INSERT INTO org_setup_batches (org_id, id, command_id, kind, undoes, steps, actor_id) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6)",
        )
        .bind(self.batch)
        .bind(command_id(self.actor)?)
        .bind(kind)
        .bind(undoes)
        .bind(serde_json::to_value(&self.steps)?)
        .bind(*self.actor.user.as_uuid())
        .execute(tx.as_mut())
        .await?;
        let action = if undoes.is_some() {
            "org_unit.setup_undo"
        } else {
            "org_unit.setup_batch"
        };
        self.events.push(audit(
            self.actor,
            action,
            "org_setup_batch",
            self.batch,
            self.admitted,
            json!({ "units": self.steps.len(), "undoes": undoes }),
        )?);
        let outcome = Outcome {
            target: Some(self.batch),
            change_mode: Some(self.admitted.mode.as_str().into()),
            count: None,
        };
        finish(tx, self.actor, &outcome).await?;
        let receipt = OrgSetupReceipt {
            batch_id: self.batch,
            change_mode: self.admitted.mode.as_str().into(),
            units: self.steps.iter().map(Step::unit).collect(),
        };
        Ok((receipt, self.events))
    }
}

impl PgEntityStore {
    /// Apply setup 부서 ops in one transaction (`POST /org-structure/batches`).
    ///
    /// # Errors
    /// `phase_not_setup`, field issues (`ops[i].…`), a per-op 409
    /// (`stale_revision`, `org_unit_has_members`, `site_is_a_workplace`), or
    /// the canonical owner's refusal.
    pub async fn apply_org_setup_batch(
        &self,
        actor: &Actor,
        ops: Vec<OrgSetupOp>,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let request = json!({ "ops": ops });
        self.run_batch(
            actor,
            "org_unit.setup_batch",
            request,
            ops,
            BatchMode::Setup,
            port,
        )
        .await
    }

    /// Run `ops` as one batch under the command `action` over `request`.
    pub(crate) async fn run_batch(
        &self,
        actor: &Actor,
        action: &'static str,
        request: Value,
        ops: Vec<OrgSetupOp>,
        mode: BatchMode,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, action, request).await? {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = if mode == BatchMode::Direct {
                    crate::org_usage::admit_direct(tx, &actor, port.as_ref(), &ops).await?
                } else {
                    admit(tx, WriteClass::OrgStructure).await?
                };
                if ops.is_empty() || ops.len() > MAX_OPS {
                    return Err(Refusal::field("ops", "out_of_range").into());
                }
                let named: Vec<Uuid> = ops.iter().flat_map(crate::org_ops::named_units).collect();
                org_tree::lock_units(tx, &named).await?;
                let mut run = Run {
                    actor: &actor,
                    port: port.as_ref(),
                    admitted,
                    today: today_kst(tx).await?,
                    batch: Uuid::new_v4(),
                    legacy: mode != BatchMode::Setup,
                    refs: HashMap::new(),
                    steps: Vec::new(),
                    events: Vec::new(),
                };
                for (i, op) in ops.iter().enumerate() {
                    crate::org_ops::apply(tx, &mut run, i, op).await?;
                }
                run.record(tx, "APPLY", None).await
            })
        })
        .await
    }
}
