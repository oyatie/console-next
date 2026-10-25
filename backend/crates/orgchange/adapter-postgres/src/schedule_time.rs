// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_orgchange_domain::PLATFORM_UTC_OFFSET;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::SettingValue;
use time::{Duration, Time};

pub(crate) async fn apply_time_in_tx(
    tx: Tx<'_, '_>,
    org: OrgId,
    now: OffsetDateTime,
) -> Result<Time, PgOrgChangeError> {
    let key = SettingKey::OrgChangeApplyTime;
    let values = resolve_in_tx(tx.as_mut(), org, &[key], None, now).await?;
    match values.get(&key) {
        Some(Ok(value)) => match value.value {
            SettingValue::Int(minutes) => Ok(Time::MIDNIGHT + Duration::minutes(minutes)),
            _ => Err(KernelError::internal("org-change apply time is not a minute value").into()),
        },
        _ => Err(KernelError::internal("org-change apply time did not resolve").into()),
    }
}

pub(crate) fn due_through(today: Date, now: OffsetDateTime, at: Time) -> Date {
    let local = now.to_offset(PLATFORM_UTC_OFFSET);
    if today > local.date() || local.time() >= at {
        today
    } else {
        today - Duration::days(1)
    }
}

pub(crate) fn scheduled_at(date: Date, at: Time) -> OffsetDateTime {
    date.with_time(at)
        .assume_offset(PLATFORM_UTC_OFFSET)
        .to_offset(time::UtcOffset::UTC)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime, time};
    #[test]
    fn due_date_tracks_the_configured_local_time_and_debug_date() {
        let today = date!(2026 - 10 - 25);
        let now = datetime!(2026-10-25 01:00 UTC);
        assert_eq!(due_through(today, now, time!(09:00)), today);
        assert_eq!(
            due_through(today, now, time!(11:00)),
            today - Duration::days(1)
        );
        assert_eq!(
            due_through(today + Duration::days(1), now, time!(11:00)),
            today + Duration::days(1)
        );
    }
}
