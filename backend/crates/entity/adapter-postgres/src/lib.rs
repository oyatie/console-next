//! Postgres adapter for 법인 · 사업자등록 · 사업장 (the one writer of the
//! entity and assignment migration tables).
//!
//! Every command runs in ONE `with_audits` transaction (RLS armed by the
//! org): it reads the tenant phase `FOR SHARE` (a concurrent 운영 시작 takes
//! `FOR UPDATE`, so the two serialise), admits the write for that phase,
//! validates with the domain, writes the head + typed revision and returns the
//! audit events, which commit with it. Revision rows store `change_mode` and a
//! settings snapshot holding the phase; audit events carry the same in `after`
//! and the `setup` badge (the 「설정 단계 기록」 filter).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod address;
mod asof;
mod assignment;
mod closure;
mod command;
mod documents;
pub mod employment_end;
pub mod employment_hire;
pub mod employment_moves;
mod employment_rows;
mod entity_batch;
mod entity_batch_check;
mod entity_batch_list;
mod entity_batch_lookup;
mod entity_batch_ops;
mod entity_batch_undo;
mod entity_close;
mod entity_reopen;
mod error;
mod format;
mod governed;
mod history;
mod history_diff;
mod identifier_correction;
mod insurance;
mod legal_entity;
mod legal_entity_revision;
mod legal_entity_tx;
pub mod name_evidence;
mod name_review;
mod org_batch;
mod org_batch_undo;
mod org_details;
// --- lane: CRUD ---
mod org_end;
mod org_ops;
mod org_position;
mod org_tree;
mod org_units;
mod org_usage;
mod read;
// --- lane: CRUD ---
mod record_end;
mod registration;
mod registration_change;
mod registration_end;
mod registration_revision;
mod reissue;
mod revision_copy;
mod scope;
mod site_unit;
mod structure;
mod structure_labels;
mod workplace;
mod workplace_branch;
mod workplace_kind;
mod workplace_revision;
mod workplace_tx;
mod workplace_views;
// --- lane: UX-R2 ENDS ---
mod workplace_close_apply;
pub mod workplace_close_plan;

pub use closure::close_workplace_in_tx;
pub use documents::DocumentContent;
pub use error::PgEntityError;
pub use governed::{
    CorrectionCover, CorrectionOutcome, CorrectionSubject, GovernedCorrectionFuture,
    GovernedCorrectionPort, OpsCover, OpsCoverFuture, RequestedCorrection,
};
pub use org_end::{EndOffer, OrgUnitEndOptions, OrgUnitErased};
pub use org_units::{OrgUnitSetupFuture, OrgUnitSetupWritePort, RoutedFuture};
pub use record_end::{OpenExitCase, RecordEndOptions};
pub use registration_end::RegistrationEndOptions;

use console_entity_application::{Actor, Revision};
use console_entity_domain::Refusal;
use console_kernel_core::tenant_phase::{
    IDENTIFIER_LOCKED, PHASE_NOT_OPERATING, PHASE_NOT_SETUP, admit_write,
};
use console_kernel_core::{
    AuditAction, AuditClassification, AuditEvent, ChangeMode, TenantPhase, WriteClass,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

pub(crate) type Tx<'a> = Transaction<'a, Postgres>;

#[derive(Clone)]
pub struct PgEntityStore {
    pool: PgPool,
}

impl std::fmt::Debug for PgEntityStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PgEntityStore")
    }
}

impl PgEntityStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

/// How a write was admitted, plus the phase it was admitted in.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Admitted {
    pub phase: TenantPhase,
    pub mode: ChangeMode,
}

impl Admitted {
    pub fn snapshot(self) -> Value {
        json!({ "phase": self.phase.as_str(), "change_mode": self.mode.as_str() })
    }
}

/// Read the phase under `FOR SHARE` and admit `class` (missing row ⇒ OPERATING).
pub(crate) async fn admit(tx: &mut Tx<'_>, class: WriteClass) -> Result<Admitted, PgEntityError> {
    let phase = read_phase(tx, true).await?;
    let mode = admit_write(phase, class).map_err(|err| {
        let remedy = match err.code {
            Some(PHASE_NOT_SETUP) if class == WriteClass::OrgStructure => "submit_org_change",
            Some(PHASE_NOT_SETUP) => "close_record_instead",
            Some(PHASE_NOT_OPERATING) => "open_go_live_preview",
            Some(IDENTIFIER_LOCKED) => "request_identifier_correction",
            _ => "contact_support",
        };
        Refusal::from(err).with_remedy(remedy)
    })?;
    Ok(Admitted { phase, mode })
}

pub(crate) async fn read_phase(tx: &mut Tx<'_>, lock: bool) -> Result<TenantPhase, PgEntityError> {
    let sql: &'static str = if lock {
        "SELECT phase FROM tenant_phase \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid FOR SHARE"
    } else {
        "SELECT phase FROM tenant_phase \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid"
    };
    let raw: Option<String> = sqlx::query_scalar(sql).fetch_optional(tx.as_mut()).await?;
    Ok(TenantPhase::from_db(raw.as_deref()))
}

/// Today as a KST calendar date, from the transaction's clock.
pub(crate) async fn today_kst(tx: &mut Tx<'_>) -> Result<time::Date, PgEntityError> {
    Ok(
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// One audit event for a write admitted as `admitted`.
pub(crate) fn audit(
    actor: &Actor,
    action: &str,
    target_type: &str,
    target_id: uuid::Uuid,
    admitted: Admitted,
    after: Value,
) -> Result<AuditEvent, PgEntityError> {
    let mut after = after;
    if let Value::Object(map) = &mut after {
        map.insert("change_mode".into(), json!(admitted.mode.as_str()));
        map.insert("phase".into(), json!(admitted.phase.as_str()));
    }
    let classification = AuditClassification {
        badges: (admitted.mode == ChangeMode::Setup).then(|| vec!["setup".to_owned()]),
        anomaly: None,
        reason: None,
    };
    Ok(AuditEvent::new(
        Some(actor.user),
        AuditAction::new(action).map_err(Refusal::from)?,
        target_type,
        target_id.to_string(),
        actor.trace.clone(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(actor.org)
    .with_snapshots(None, Some(after))
    .with_classification(classification))
}

/// Revision bookkeeping shared by every typed revision insert.
pub(crate) struct RevisionMeta<'a> {
    pub version: i32,
    pub effective_from: time::Date,
    pub reason_code: console_entity_domain::RevisionReason,
    pub admitted: Admitted,
    pub actor: &'a Actor,
    /// The validated draft, hashed into `payload_digest`.
    pub payload: Value,
}

/// A revise request's envelope, parsed.
pub(crate) struct Envelope {
    pub effective_from: time::Date,
    pub reason: console_entity_domain::PersonReason,
    pub expected_version: i32,
}

/// Parse the revision envelope: `expected_version` (required), `effective_from`
/// (required; may be in the future) and `reason_code` (a person's: a server
/// marker is `reason_code_reserved`, 0h).
pub(crate) fn revision_envelope<T>(rev: &Revision<T>) -> Result<Envelope, PgEntityError> {
    let mut is = console_entity_domain::Issues::default();
    if rev.expected_version.is_none_or(|v| v < 1) {
        is.push("expected_version", "required");
    }
    let date = is.date("effective_from", rev.effective_from.as_deref(), true, None);
    let reason =
        console_entity_domain::revision_reason::person_reason(&mut is, rev.reason_code.as_deref());
    Ok(is.finish_opt(|| {
        Some(Envelope {
            effective_from: date?,
            reason: reason?,
            expected_version: rev.expected_version?,
        })
    })?)
}

/// 409 `stale_revision` unless the head (locked `FOR UPDATE` by the caller)
/// is still at the version the client read.
pub(crate) fn ensure_version(expected: i32, current: i32) -> Result<(), PgEntityError> {
    if expected == current {
        Ok(())
    } else {
        Err(Refusal::stale_revision(expected, current).into())
    }
}
