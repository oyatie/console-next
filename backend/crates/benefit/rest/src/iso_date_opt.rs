// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Deserializer};
use time::Date;
use time::format_description::well_known::Iso8601;

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Date>, D::Error> {
    let raw: Option<String> = Option::deserialize(deserializer)?;
    raw.map(|value| Date::parse(&value, &Iso8601::DATE))
        .transpose()
        .map_err(serde::de::Error::custom)
}
