//! INF-03 idle sign-out (design/security-admin.md R-3; 개인정보의 안전성
//! 확보조치 기준 §6④; NIST SP 800-63B §7.2).
//!
//! Activity is user input only. The client sends its last pointerdown,
//! keydown or touchstart as `X-Last-Interaction` (RFC 3339). The server keeps
//! `last_activity_at` on the refresh family and advances it only from that
//! header, clamped to `[stored, now]`; a missing or unparseable value never
//! advances it, so a background request or a reopened tab cannot revive a
//! session. A gap longer than the family's `idle_timeout_minutes` (before the
//! interaction, or since it) ends the session: requests are refused, and the
//! refresh that follows ends the family with `revoked_reason = 'idle_timeout'`
//! and answers `session_idle_expired`.

use console_kernel_core::OrgId;
use console_platform_db::settings_read::resolve_in_tx;
use console_settings_domain::SettingKey;
use sqlx::{PgConnection, Postgres, Transaction};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::AuthError;

/// The request header carrying the client's last user interaction.
pub const LAST_INTERACTION_HEADER: &str = "x-last-interaction";
/// `revoked_reason` of a family ended for inactivity.
pub const IDLE_TIMEOUT_REASON: &str = "idle_timeout";
/// The audit action of a family ended for inactivity.
pub const IDLE_AUDIT_ACTION: &str = "auth.session.idle_timeout";
/// Write `last_activity_at` back only when it moves at least this far, so an
/// active user costs at most one UPDATE a minute (R-3). A write throttle,
/// not a policy value: it never changes when a session ends.
const WRITE_BACK_STEP: Duration = Duration::seconds(60);

/// Parse `X-Last-Interaction`. Anything but RFC 3339 is "no interaction".
#[must_use]
pub fn parse_last_interaction(raw: Option<&str>) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(raw?.trim(), &Rfc3339).ok()
}

/// `clamp(sent, stored, now)`: a replayed old value never moves activity
/// back, and a future value counts as `now`.
#[must_use]
pub fn effective_activity(
    stored: OffsetDateTime,
    sent: Option<OffsetDateTime>,
    now: OffsetDateTime,
) -> OffsetDateTime {
    sent.map_or(stored, |sent| sent.min(now).max(stored))
}

/// More than `minutes` passed between `from` and `to`.
#[must_use]
pub fn is_idle(from: OffsetDateTime, to: OffsetDateTime, minutes: i64) -> bool {
    to - from > Duration::minutes(minutes)
}

/// The request-boundary rule: the session ended if either gap, from the
/// stored activity to the interaction sent now, or from that interaction to
/// now, is longer than the timeout. Input after an idle gap never revives it.
#[must_use]
pub fn idle_at_request(
    stored: OffsetDateTime,
    sent: Option<OffsetDateTime>,
    now: OffsetDateTime,
    minutes: i64,
) -> bool {
    let effective = effective_activity(stored, sent, now);
    is_idle(stored, effective, minutes) || is_idle(effective, now, minutes)
}

/// Whether the request must write activity back.
#[must_use]
pub fn needs_write_back(stored: OffsetDateTime, effective: OffsetDateTime) -> bool {
    effective - stored >= WRITE_BACK_STEP
}

/// The tenant's `auth.idle_timeout_minutes` in force at `now` (the code
/// default when the tenant has no override). Runs on an armed transaction.
///
/// # Errors
/// Fails closed: a query error or a stored value that no longer resolves.
pub async fn resolve_idle_minutes(
    conn: &mut PgConnection,
    org: OrgId,
    now: OffsetDateTime,
) -> Result<i64, AuthError> {
    let key = SettingKey::AuthIdleTimeoutMinutes;
    resolve_in_tx(conn, org, &[key], None, now)
        .await?
        .remove(&key)
        .and_then(|resolved| resolved.ok())
        .and_then(|resolved| resolved.value.as_int())
        .ok_or_else(|| AuthError::InvalidStoredData(format!("{} is unresolved", key.as_str())))
}

/// The refresh-time check (R-3: "refresh keeps the same check") against a
/// fresh resolve of the tenant's value, which it snapshots on the family.
/// Refresh carries no interaction, so it never advances activity.
/// `Ok(false)`: the family was idle and is now ended (the caller audits).
///
/// # Errors
/// Storage failures.
pub(crate) async fn check_refresh_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    family: Uuid,
    last_activity_at: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<bool, AuthError> {
    let minutes = resolve_idle_minutes(tx.as_mut(), org, now).await?;
    let idle = is_idle(last_activity_at, now, minutes);
    let snapshot = i32::try_from(minutes)
        .map_err(|_| AuthError::InvalidStoredData("idle timeout out of range".into()))?;
    sqlx::query(
        "UPDATE auth_refresh_token_families \
            SET idle_timeout_minutes = $2, \
                revoked_at = CASE WHEN $3 THEN COALESCE(revoked_at, $4) ELSE revoked_at END, \
                revoked_reason = CASE WHEN $3 THEN COALESCE(revoked_reason, $5) ELSE revoked_reason END \
          WHERE id = $1",
    )
    .bind(family)
    .bind(snapshot)
    .bind(idle)
    .bind(now)
    .bind(IDLE_TIMEOUT_REASON)
    .execute(tx.as_mut())
    .await?;
    if idle {
        sqlx::query(
            "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, $1) WHERE family_id = $2",
        )
        .bind(now)
        .bind(family)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(!idle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    const T: OffsetDateTime = datetime!(2026-10-03 10:00 UTC);

    #[test]
    fn missing_or_garbage_header_never_advances() {
        assert_eq!(effective_activity(T, None, T + Duration::hours(1)), T);
        assert_eq!(parse_last_interaction(Some("yesterday")), None);
        assert_eq!(parse_last_interaction(None), None);
    }

    #[test]
    fn replayed_old_value_never_moves_back_and_future_is_clamped() {
        let now = T + Duration::minutes(10);
        assert_eq!(effective_activity(T, Some(T - Duration::hours(1)), now), T);
        assert_eq!(
            effective_activity(T, Some(now + Duration::days(1)), now),
            now
        );
        let sent = T + Duration::minutes(4);
        assert_eq!(effective_activity(T, Some(sent), now), sent);
        assert_eq!(
            parse_last_interaction(Some(" 2026-10-03T10:04:00Z ")),
            Some(sent)
        );
    }

    #[test]
    fn idle_is_strictly_past_the_value_at_floor_and_ceiling() {
        for minutes in [5, 30, 60] {
            let edge = T + Duration::minutes(minutes);
            assert!(!is_idle(T, edge, minutes));
            assert!(is_idle(T, edge + Duration::seconds(1), minutes));
        }
    }

    #[test]
    fn input_after_an_idle_gap_never_revives_the_session() {
        let back = T + Duration::minutes(31);
        // The first press after 31 idle minutes carries `now`: still ended.
        assert!(idle_at_request(T, Some(back), back, 30));
        // No header: the stored activity alone decides.
        assert!(idle_at_request(T, None, back, 30));
        // A press within the window, reported now, keeps it.
        assert!(!idle_at_request(
            T,
            Some(T + Duration::minutes(29)),
            back,
            30
        ));
        // Steady use (input each minute) never ends it.
        assert!(!idle_at_request(
            T,
            Some(T + Duration::minutes(1)),
            T + Duration::minutes(1),
            30
        ));
    }

    #[test]
    fn write_back_at_most_once_a_minute() {
        assert!(!needs_write_back(T, T + Duration::seconds(59)));
        assert!(needs_write_back(T, T + Duration::seconds(60)));
    }

    #[test]
    fn registry_default_is_inside_the_declared_bounds() {
        let def = SettingKey::AuthIdleTimeoutMinutes.def();
        let default = def.default.and_then(|v| v.as_int());
        assert!(default.is_some_and(|m| (5..=60).contains(&m)));
    }
}
