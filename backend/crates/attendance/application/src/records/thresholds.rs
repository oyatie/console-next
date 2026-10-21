//! Unwrap effective registry values before the domain evaluates a day.
use std::collections::BTreeMap;

use console_attendance_domain::records::Thresholds;
use console_kernel_core::Resolved;
use console_settings_domain::{SettingError, SettingKey as K, SettingValue};

pub const KEYS: [K; 3] = [
    K::AttendanceExcessNoticeMinutes,
    K::AttendanceLateGraceMinutes,
    K::AttendanceLongSpanConfirmMinutes,
];

/// Missing, malformed or out-of-range settings refuse evaluation.
pub fn from_settings(
    settings: &BTreeMap<K, Result<Resolved<SettingValue>, SettingError>>,
) -> Result<Thresholds, SettingError> {
    let minutes = |key: K| {
        let value = settings
            .get(&key)
            .ok_or(SettingError::FactUndeclared(key))?
            .as_ref()
            .map_err(Clone::clone)?
            .value;
        if !key.def().in_range(value) {
            return Err(SettingError::OutOfRange(key));
        }
        value
            .as_int()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or(SettingError::InvalidValue(key))
    };
    Ok(Thresholds {
        long_span_minutes: minutes(K::AttendanceLongSpanConfirmMinutes)?,
        notice_minutes: minutes(K::AttendanceExcessNoticeMinutes)?,
        grace_minutes: minutes(K::AttendanceLateGraceMinutes)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_attendance_domain::{
        records::{Mark, Recognition, Recorded, marks},
        schedule::DayKind,
    };
    use console_settings_domain::resolve;
    use time::OffsetDateTime;

    #[test]
    fn registry_defaults_preserve_zero_and_overrides_drive_marks() {
        let mut values: BTreeMap<_, _> = KEYS
            .into_iter()
            .map(|k| (k, resolve(k, &[], None, OffsetDateTime::UNIX_EPOCH)))
            .collect();
        let defaults = from_settings(&values).unwrap();
        assert_eq!((defaults.notice_minutes, defaults.grace_minutes), (0, 0));
        let rec = Recognition {
            late_in: 5,
            late_unrecognised: 10,
            ..Default::default()
        };
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Times, &rec, true, defaults),
            vec![Mark::UnapprovedExcess, Mark::Late]
        );
        values
            .get_mut(&K::AttendanceExcessNoticeMinutes)
            .unwrap()
            .as_mut()
            .unwrap()
            .value = SettingValue::Int(10);
        values
            .get_mut(&K::AttendanceLateGraceMinutes)
            .unwrap()
            .as_mut()
            .unwrap()
            .value = SettingValue::Int(5);
        assert!(
            marks(
                DayKind::Work,
                false,
                Recorded::Times,
                &rec,
                true,
                from_settings(&values).unwrap()
            )
            .is_empty()
        );
        assert_eq!(
            (rec.late_in, rec.late_unrecognised),
            (5, 10),
            "facts are preserved"
        );
    }

    #[test]
    fn corrupt_or_missing_settings_never_become_a_zero_fallback() {
        let defaults = || {
            KEYS.into_iter()
                .map(|k| (k, resolve(k, &[], None, OffsetDateTime::UNIX_EPOCH)))
                .collect::<BTreeMap<_, _>>()
        };
        for (key, bad) in [
            (KEYS[0], SettingValue::Int(-1)),
            (KEYS[0], SettingValue::Int(31)),
            (KEYS[1], SettingValue::Int(61)),
            (KEYS[1], SettingValue::Bool(true)),
            (KEYS[2], SettingValue::Int(0)),
            (KEYS[2], SettingValue::Int(1441)),
        ] {
            let mut values = defaults();
            values.get_mut(&key).unwrap().as_mut().unwrap().value = bad;
            assert!(from_settings(&values).is_err());
        }
        let mut values = defaults();
        values.remove(&KEYS[0]);
        assert!(from_settings(&values).is_err());
        values.insert(KEYS[0], Err(SettingError::FactUndeclared(KEYS[0])));
        assert!(from_settings(&values).is_err());
    }
}
