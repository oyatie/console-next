// SPDX-License-Identifier: LicenseRef-Proprietary
//! Serde boundary for UTC RFC 3339 timestamps; invalid values fail serialization.
use serde::{Serialize, Serializer, ser::Error};

pub use time::serde::rfc3339::deserialize;

/// Serialize a timestamp using the shared UTC formatter.
/// # Errors
/// Returns a serializer error if RFC 3339 cannot represent the value.
pub fn serialize<S: Serializer>(
    value: &crate::Timestamp,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    crate::rfc3339(*value)
        .map_err(S::Error::custom)?
        .serialize(serializer)
}

pub mod option {
    use super::*;
    pub use time::serde::rfc3339::option::deserialize;

    /// Serialize an optional timestamp as an RFC 3339 string or null.
    /// # Errors
    /// Returns a serializer error if RFC 3339 cannot represent a present value.
    pub fn serialize<S: Serializer>(
        value: &Option<crate::Timestamp>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .map(crate::rfc3339)
            .transpose()
            .map_err(S::Error::custom)?
            .serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use time::macros::datetime;

    #[derive(Serialize, Deserialize)]
    struct Response {
        #[serde(with = "crate::timestamp")]
        instant: crate::Timestamp,
        #[serde(with = "crate::timestamp::option")]
        optional: Option<crate::Timestamp>,
    }

    #[test]
    fn normalizes_offsets_preserves_fractions_and_round_trips_null() {
        let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
        for optional in [Some(at), None] {
            let value = serde_json::to_value(Response {
                instant: at,
                optional,
            })
            .unwrap();
            assert_eq!(value["instant"], "2026-11-05T03:31:02.238349Z");
            assert_eq!(
                value["optional"],
                serde_json::json!(optional.map(|_| "2026-11-05T03:31:02.238349Z"))
            );
            let read: Response = serde_json::from_value(value).unwrap();
            assert_eq!(read.instant, at);
            assert_eq!(read.optional, optional);
        }
    }

    #[test]
    fn refuses_unrepresentable_required_and_optional_timestamps() {
        let invalid = datetime!(-0001-01-01 00:00 UTC);
        for (instant, optional) in [
            (invalid, None),
            (crate::Timestamp::UNIX_EPOCH, Some(invalid)),
        ] {
            assert!(serde_json::to_value(Response { instant, optional }).is_err());
        }
    }
}
