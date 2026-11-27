// SPDX-License-Identifier: LicenseRef-Proprietary
//! Periodic quarterly role-grant access reviews (`BG-10`).

mod complete;
mod read;
mod types;
mod write;

pub use complete::{CompleteReviewInput, complete};
pub use read::{ExportQuery, export_csv, get, list};
pub use types::{
    AccessReviewDecisionInput, AccessReviewDecisionKind, AccessReviewDetail, AccessReviewItemOut,
    AccessReviewSummary,
};
pub use write::{decide, start};

use console_kernel_core::AuditEvent;
use console_platform_authz::{
    Principal,
    access::{Domain, Level},
};
use sqlx::{Postgres, Transaction};
use time::{Date, Month, OffsetDateTime, Time, UtcOffset};

use crate::{
    AccessError, AccessResult,
    actor::{Actor, audit},
};

pub(super) fn parse_quarter(period: &str) -> AccessResult<(i32, u8)> {
    let Some((year_str, q_str)) = period.split_once("-Q") else {
        return Err(AccessError::invalid(
            "period_invalid",
            "period must match YYYY-Q1..Q4",
        ));
    };
    let year: i32 = year_str
        .parse()
        .ok()
        .filter(|y| (2000..=2100).contains(y))
        .ok_or_else(|| AccessError::invalid("period_invalid", "invalid review year"))?;
    let q: u8 = q_str
        .parse()
        .ok()
        .filter(|q| (1..=4).contains(q))
        .ok_or_else(|| AccessError::invalid("period_invalid", "invalid review quarter"))?;
    Ok((year, q))
}

pub(super) fn quarter_due_at(year: i32, quarter: u8) -> AccessResult<OffsetDateTime> {
    let month = match quarter {
        1 => Month::February,
        2 => Month::May,
        3 => Month::August,
        _ => Month::November,
    };
    let kst = UtcOffset::from_hms(9, 0, 0).map_err(AccessError::internal)?;
    let date = Date::from_calendar_date(year, month, 16).map_err(AccessError::internal)?;
    Ok(date.with_time(Time::MIDNIGHT).assume_offset(kst))
}

pub(super) fn current_and_next_quarters(now: OffsetDateTime) -> (String, String) {
    let kst = UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC);
    let local = now.to_offset(kst);
    let year = local.year();
    let q = ((u8::from(local.month()) - 1) / 3) + 1;
    let current = format!("{year}-Q{q}");
    let next = if q == 4 {
        format!("{}-Q1", year + 1)
    } else {
        format!("{year}-Q{}", q + 1)
    };
    (current, next)
}

pub(super) async fn require_review_access(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    write: bool,
) -> AccessResult<()> {
    let actor = Actor::load(tx, p).await?;
    let allowed = if write {
        actor.may(Domain::Access, Level::Edit, &actor.tenant())
            || actor.may(Domain::Audit, Level::Approve, &actor.tenant())
    } else {
        actor.may(Domain::Access, Level::View, &actor.tenant())
            || actor.may(Domain::Audit, Level::View, &actor.tenant())
    };
    if allowed {
        return Ok(());
    }
    let has_narrow = actor.subject.grants.iter().any(|g| {
        actor.may(Domain::Access, Level::View, &g.scope)
            || actor.may(Domain::Audit, Level::View, &g.scope)
    });
    if has_narrow {
        return Err(AccessError::forbidden(
            "scope_tenant_wide_only",
            "access review requires tenant-wide access",
        ));
    }
    Err(AccessError::access_denied())
}

pub(super) async fn lock_period(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    period: &str,
) -> AccessResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
        .bind(format!("access_review:{}", p.org_id))
        .bind(period)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(super) fn review_event(
    p: &Principal,
    period: &str,
    action: &'static str,
) -> AccessResult<AuditEvent> {
    let mut ev = audit(p, action, "access_review", *p.org_id.as_uuid())?;
    ev.target_id = period.to_owned();
    Ok(ev)
}
