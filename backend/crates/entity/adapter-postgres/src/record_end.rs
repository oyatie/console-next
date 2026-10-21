//! Unused legal entities and workplaces can be voided; used records are closed with history retained.
//! Voiding preserves the uploaded registration certificate's retention key.

use console_entity_application::Actor;
use console_entity_domain::Refusal;
use console_kernel_core::{ChangeMode, TenantPhase};
use console_platform_db::with_org_conn;
use serde::Serialize;
use uuid::Uuid;

use crate::org_end::EndOffer;
use crate::{Admitted, PgEntityError, PgEntityStore, Tx, read_phase};

/// `GET /legal-entities/{id}/end-options`, `GET /workplaces/{id}/end-options`.
#[derive(Debug, Clone, Serialize)]
pub struct RecordEndOptions {
    pub id: Uuid,
    pub phase: &'static str,
    /// 삭제: the void (never used; during setup, nobody placed now).
    pub delete: EndOffer,
    /// 폐쇄 (사업장) / 폐업 (법인): the close, history kept. Its own blockers
    /// (people still placed, 대표 사업장 …) are the close sheet's to show.
    pub close: EndOffer,
    /// UX-R2 ENDS (company-52): exit cases still open for anyone ever placed
    /// here, so a close never hides a 퇴직 (and its 금품청산 clock) in flight.
    pub open_exit_cases: Vec<OpenExitCase>,
}

/// An open exit case (not rejected, cancelled or submitted).
#[derive(Debug, Clone, Serialize)]
pub struct OpenExitCase {
    pub case_id: Uuid,
    pub employee_id: Uuid,
    pub employee_name: String,
    pub status: String,
    pub effective_exit_date: String,
}

async fn open_exit_cases(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<Vec<OpenExitCase>, PgEntityError> {
    let rows: Vec<(Uuid, Uuid, String, String, String)> = sqlx::query_as(
        "SELECT c.id, c.employee_id, e.name, c.status, c.effective_exit_date::TEXT \
         FROM employee_exit_cases c JOIN employees e ON e.id = c.employee_id \
         WHERE c.status NOT IN ('REJECTED', 'CANCELLED', 'SUBMITTED') AND EXISTS ( \
           SELECT 1 FROM employment_assignments a WHERE a.employee_id = c.employee_id \
             AND a.superseded_at IS NULL AND (a.workplace_id = $1 OR ($2 AND a.legal_entity_id = $1))) \
         ORDER BY c.effective_exit_date, c.id",
    )
    .bind(id)
    .bind(column == "legal_entity_id")
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(case_id, employee_id, employee_name, status, effective_exit_date)| OpenExitCase {
                case_id,
                employee_id,
                employee_name,
                status,
                effective_exit_date,
            },
        )
        .collect())
}

/// Why the record cannot be deleted after 운영 시작, if it cannot:
/// `record_has_units` (부서 that can be erased first) or `record_has_history`
/// (anyone ever assigned or placed there, or a 부서 that was ever under it).
async fn used(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<Option<&'static str>, PgEntityError> {
    let whole = column == "legal_entity_id";
    let (history, units): (bool, bool) = sqlx::query_as(
        "WITH wps AS (SELECT w.id FROM workplaces w WHERE w.id = $1 OR ($2 AND w.legal_entity_id = $1)), \
              sites AS (SELECT DISTINCT p.org_unit_id::text AS id FROM org_unit_placements p \
                         WHERE p.represents_workplace AND (p.workplace_id IN (SELECT id FROM wps) \
                               OR ($2 AND p.legal_entity_id = $1))), \
              heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes FROM org_unit_revisions \
                         ORDER BY org_unit_id, version DESC) \
         SELECT \
           EXISTS (SELECT 1 FROM employment_assignments a \
                    WHERE a.workplace_id IN (SELECT id FROM wps) OR ($2 AND a.legal_entity_id = $1)) \
           OR EXISTS (SELECT 1 FROM org_unit_placements p WHERE NOT p.represents_workplace \
                       AND (p.workplace_id IN (SELECT id FROM wps) OR ($2 AND p.legal_entity_id = $1)) \
                       AND EXISTS (SELECT 1 FROM heads h WHERE h.org_unit_id = p.org_unit_id \
                                    AND h.attributes->>'status' = 'dissolved')) \
           OR EXISTS (SELECT 1 FROM org_unit_revisions r JOIN heads h ON h.org_unit_id = r.org_unit_id \
                       WHERE r.attributes->>'parent_id' IN (SELECT id FROM sites) \
                         AND h.attributes->>'status' = 'dissolved'), \
           EXISTS (SELECT 1 FROM heads h WHERE h.attributes->>'parent_id' IN (SELECT id FROM sites) \
                    AND h.attributes->>'status' IS DISTINCT FROM 'dissolved')",
    )
    .bind(id)
    .bind(whole)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(if history {
        Some("record_has_history")
    } else if units {
        Some("record_has_units")
    } else {
        None
    })
}

fn refusal(code: &'static str) -> PgEntityError {
    let (message, remedy) = if code == "record_has_units" {
        ("부서 are still under this record", "erase_units_first")
    } else {
        (
            "this record was used; close it to keep its history",
            "close_record_instead",
        )
    };
    Refusal::conflict(code, message).with_remedy(remedy).into()
}

/// Admit the void of the 사업장 or 법인 `id` (`column` = `workplace_id` /
/// `legal_entity_id`): a setup undo during SETUP; after 운영 시작 GOVERNED,
/// for a record nothing ever used.
pub(crate) async fn admit_void(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<Admitted, PgEntityError> {
    let phase = read_phase(tx, true).await?;
    if phase == TenantPhase::Setup {
        return Ok(Admitted {
            phase,
            mode: ChangeMode::Setup,
        });
    }
    if let Some(code) = used(tx, column, id).await? {
        return Err(refusal(code));
    }
    Ok(Admitted {
        phase,
        mode: ChangeMode::Governed,
    })
}

impl PgEntityStore {
    /// Whether the 사업장 or 법인 `id` is deleted or closed, and why not the other.
    ///
    /// # Errors
    /// Database faults.
    pub async fn record_end_options(
        &self,
        actor: &Actor,
        column: &'static str,
        id: Uuid,
    ) -> Result<RecordEndOptions, PgEntityError> {
        with_org_conn(&self.pool, actor.org, |tx| {
            Box::pin(async move {
                let phase = read_phase(tx, false).await?;
                let refused = if phase == TenantPhase::Setup {
                    in_use_now(tx, column, id).await?
                } else {
                    used(tx, column, id).await?
                };
                let close = if refused.is_none() {
                    Some("record_never_used")
                } else {
                    None
                };
                Ok(RecordEndOptions {
                    id,
                    phase: phase.as_str(),
                    delete: EndOffer::from(refused),
                    close: EndOffer::from(close),
                    open_exit_cases: open_exit_cases(tx, column, id).await?,
                })
            })
        })
        .await
    }
}

/// During setup: `record_in_use` while anyone is placed there now (the void's
/// own check, read without writing).
async fn in_use_now(
    tx: &mut Tx<'_>,
    column: &'static str,
    id: Uuid,
) -> Result<Option<&'static str>, PgEntityError> {
    Ok(
        match crate::site_unit::ensure_unused(tx, column, id).await {
            Ok(()) => None,
            Err(PgEntityError::Refused(r)) if r.code == "record_in_use" => Some("record_in_use"),
            Err(e) => return Err(e),
        },
    )
}
