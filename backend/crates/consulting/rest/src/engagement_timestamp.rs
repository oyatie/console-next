// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serializer};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, Time, UtcOffset};

/// `time`'s two persisted shapes: RFC 3339 (current) and the component array
/// its non-human-readable `Serialize` impl emits (legacy, read-only).
#[derive(Deserialize)]
#[serde(untagged)]
enum Stored {
    Rfc3339(String),
    LegacyComponents(i32, u16, u8, u8, u8, u32, i8, i8, i8),
}

pub(super) fn serialize<S: Serializer>(
    value: &OffsetDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    time::serde::rfc3339::serialize(value, serializer)
}

pub(super) fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<OffsetDateTime, D::Error> {
    match Stored::deserialize(deserializer)? {
        Stored::Rfc3339(raw) => OffsetDateTime::parse(&raw, &Rfc3339).map_err(D::Error::custom),
        Stored::LegacyComponents(
            year,
            ordinal,
            hour,
            minute,
            second,
            nanosecond,
            offset_hours,
            offset_minutes,
            offset_seconds,
        ) => {
            let date = Date::from_ordinal_date(year, ordinal).map_err(D::Error::custom)?;
            let time =
                Time::from_hms_nano(hour, minute, second, nanosecond).map_err(D::Error::custom)?;
            let offset = UtcOffset::from_hms(offset_hours, offset_minutes, offset_seconds)
                .map_err(D::Error::custom)?;
            Ok(date.with_time(time).assume_offset(offset))
        }
    }
}
