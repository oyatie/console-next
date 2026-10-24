//! Scheduled personnel actions (발령 효력 예정): applies lifecycle events whose
//! effective date has arrived in Asia/Seoul. The HR module owns the locked,
//! tenant-armed, audited apply; app composition owns this loop's lifetime.
//! The same tick re-locks expired period unlock windows (BW-15), resumes
//! import apply jobs whose driver died (W11) and, in the worker role only
//! (lane correction #14), tombstones voided registrations past their
//! retention (MR-26), runs the daily lifecycle case clock tick (LC-B3) and
//! prunes old pre-auth rate-limit windows.
//!
//! Runs in BOTH the api and the worker role: the dev/E2E launcher starts only
//! the api role, and every due event is claimed with `FOR UPDATE SKIP LOCKED`
//! and re-checked as still SCHEDULED, so any number of replicas apply each
//! event exactly once.
//!
//! # Deterministic apply for E2E (debug builds only)
//!
//! `CONSOLE_DEV_LIFECYCLE_TODAY_FILE=<path>`, read once at start, makes this
//! loop tick every second and apply events due on
//! `max(real KST today, the YYYY-MM-DD in <path>)`. A missing, empty or
//! unreadable file means the real date, and the clock never moves backwards.
//! Only this loop's notion of "today" moves: scheduling, validation and every
//! other date check keep the real KST date, so an E2E schedules an event for
//! tomorrow as usual, writes tomorrow's date into the file, and sees the event
//! APPLIED within a tick. The override is compiled out of release builds — a
//! release binary ignores the variable (and logs that it did), so it is never
//! reachable in production.

use std::time::Duration;

use time::Date;
use tokio::sync::watch;

const DEV_TODAY_FILE_ENV: &str = "CONSOLE_DEV_LIFECYCLE_TODAY_FILE";

pub struct LifecycleScheduleHandle {
    shutdown_tx: watch::Sender<bool>,
}

impl LifecycleScheduleHandle {
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[must_use]
pub fn spawn(pool: sqlx::PgPool, worker: bool) -> LifecycleScheduleHandle {
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let today_file = dev_today_file();
    let period = if today_file.is_some() {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(60)
    };
    tokio::spawn(async move {
        // LC-B3: the day the case clock tick last finished in every tenant.
        let mut case_clock_day: Option<Date> = None;
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() { break; }
                }
                _ = ticker.tick() => {
                    let override_date = match &today_file {
                        Some(path) => tokio::fs::read_to_string(path).await.ok(),
                        None => None,
                    };
                    let today = effective_today(crate::hr::today_kst(), override_date.as_deref());
                    match crate::hr::apply_due_lifecycle_events(&pool, today).await {
                        Ok(0) => {},
                        Ok(settled) => tracing::info!(settled, "scheduled lifecycle events settled"),
                        Err(error) => tracing::warn!(%error, "scheduled lifecycle event run failed"),
                    }
                    if let Err(error) = console_platform_access::pending::activate_due(&pool, &console_kernel_core::SystemClock).await {
                        tracing::error!(?error, "pending grant scheduler failed");
                    }
                    crate::workplace_close_schedule::tick(&pool, today).await;
                    crate::org_change_schedule::tick(&pool, today).await;
                    crate::requests::tick(&pool).await;
                    if let Err(error)=console_platform_rest::expire_support_sessions(&pool).await {
                        tracing::error!(%error,"support session expiry failed");
                    }
                    // BW-15: expired unlock windows get their successor lock row.
                    match crate::lifecycle::period_relock::relock_due(&pool).await {
                        Ok(0) => {},
                        Ok(relocked) => tracing::info!(relocked, "expired period unlocks re-locked"),
                        Err(error) => tracing::warn!(%error, "period re-lock run failed"),
                    }
                    // W11: an import apply job whose driver died (both roles; the
                    // claim is SKIP LOCKED, so replicas never drive one twice).
                    match console_hr_adapter_postgres::HrService::new(pool.clone())
                        .resume_stale_applies()
                        .await
                    {
                        Ok(0) => {},
                        Ok(resumed) => tracing::info!(resumed, "stale import apply jobs resumed"),
                        Err(error) => tracing::warn!(%error, "stale import apply resume failed"),
                    }
                    match console_hr_adapter_postgres::HrService::new(pool.clone()).resume_import_rollbacks().await {
                        Ok(0) => {},
                        Ok(resumed) => tracing::info!(resumed, "import rollback jobs resumed"),
                        Err(error) => tracing::warn!(code=error.code, "import rollback resume failed"),
                    }
                    // CAP-04: a bulk 발령 job whose driver died is finished from what committed.
                    match console_hr_adapter_postgres::HrService::new(pool.clone()).finish_stale_bulk_lifecycle_jobs().await {
                        Ok(0) => {},
                        Ok(finished) => tracing::info!(finished, "stale bulk lifecycle jobs finished"),
                        Err(error) => tracing::warn!(%error, "stale bulk lifecycle job pass failed"),
                    }
                    // MR-26: voided registrations past people.void_pii_retention
                    // become tombstones. Worker role only (lane correction #14).
                    if worker {
                        match console_hr_adapter_postgres::HrService::new(pool.clone())
                            .destroy_due_void_pii()
                            .await
                        {
                            Ok(0) => {},
                            Ok(destroyed) => tracing::info!(destroyed, "voided registrations tombstoned"),
                            Err(error) => tracing::warn!(error = %error.message, "void PII destruction run failed"),
                        }
                        // LC-B3: once per KST day, case due dates and the due/overdue
                        // change events (replica-safe: the day is claimed per tenant).
                        if case_clock_day != Some(today) {
                            match run_case_clock_tick(&pool, today).await {
                                Ok(changed) => {
                                    case_clock_day = Some(today);
                                    if changed > 0 {
                                        tracing::info!(changed, "lifecycle case clocks ticked");
                                    }
                                }
                                Err(error) => tracing::warn!(%error, "lifecycle case clock tick failed"),
                            }
                        }
                        // R5: pre-auth rate-limit windows older than an hour.
                        match console_platform_auth_rest::prune_rate_limit_windows(&pool).await {
                            Ok(0) => {},
                            Ok(pruned) => tracing::debug!(pruned, "auth rate-limit windows pruned"),
                            Err(error) => tracing::warn!(%error, "auth rate-limit prune failed"),
                        }
                    }
                }
            }
        }
    });
    LifecycleScheduleHandle { shutdown_tx }
}

async fn run_case_clock_tick(pool: &sqlx::PgPool, today: Date) -> Result<usize, String> {
    let register = console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .map_err(|error| error.to_string())?;
    console_hr_adapter_postgres::HrService::new(pool.clone())
        .run_case_clock_tick(today, &register)
        .await
}

#[cfg(debug_assertions)]
fn dev_today_file() -> Option<std::path::PathBuf> {
    let path = std::env::var_os(DEV_TODAY_FILE_ENV).filter(|value| !value.is_empty())?;
    tracing::warn!(
        path = %std::path::Path::new(&path).display(),
        "{DEV_TODAY_FILE_ENV} is set: scheduled lifecycle events apply on the date in that file (debug build only)"
    );
    Some(path.into())
}

#[cfg(not(debug_assertions))]
fn dev_today_file() -> Option<std::path::PathBuf> {
    if std::env::var_os(DEV_TODAY_FILE_ENV).is_some() {
        tracing::error!(
            "{DEV_TODAY_FILE_ENV} is ignored: the lifecycle date override exists only in debug builds"
        );
    }
    None
}

/// The date the applier treats as today: the later of the real KST date and a
/// readable `YYYY-MM-DD` override. Never earlier than the real date.
fn effective_today(real: Date, override_date: Option<&str>) -> Date {
    override_date
        .and_then(|text| {
            Date::parse(
                text.trim(),
                &time::format_description::well_known::Iso8601::DATE,
            )
            .ok()
        })
        .map_or(real, |date| date.max(real))
}

#[cfg(test)]
mod tests {
    use super::effective_today;
    use time::macros::date;

    #[test]
    fn override_only_moves_the_date_forward() {
        let real = date!(2026 - 10 - 01);
        assert_eq!(effective_today(real, None), real);
        assert_eq!(effective_today(real, Some("")), real);
        assert_eq!(effective_today(real, Some("not a date")), real);
        assert_eq!(
            effective_today(real, Some("2026-10-02\n")),
            date!(2026 - 10 - 02)
        );
        assert_eq!(effective_today(real, Some("2026-09-01")), real);
    }
}
