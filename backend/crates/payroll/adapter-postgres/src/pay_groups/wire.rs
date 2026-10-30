// SPDX-License-Identifier: LicenseRef-Proprietary
//! Serde stays at the adapter boundary.
use console_payroll_domain::pay_groups::*;
use serde::{Deserialize, Serialize};

macro_rules! day_wire {
    ($module:ident, $ty:ident, $variant:ident, $keyword:literal) => {
        pub(crate) mod $module {
            use super::*;
            pub fn serialize<S: serde::Serializer>(
                value: &$ty,
                serializer: S,
            ) -> Result<S::Ok, S::Error> {
                match value {
                    $ty::Day(day) => day.serialize(serializer),
                    $ty::$variant => $keyword.serialize(serializer),
                }
            }
            pub fn deserialize<'de, D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<$ty, D::Error> {
                match serde_json::Value::deserialize(deserializer)? {
                    serde_json::Value::Number(n) => {
                        n.as_u64().and_then(|n| u8::try_from(n).ok()).map($ty::Day)
                    }
                    serde_json::Value::String(s) if s == $keyword => Some($ty::$variant),
                    _ => None,
                }
                .ok_or_else(|| serde::de::Error::custom("invalid calendar day"))
            }
        }
    };
}
day_wire!(pay_day, PayDay, LastDay, "LAST_DAY");
day_wire!(period_start, PeriodStart, First, "FIRST");

#[derive(Deserialize, Serialize)]
#[serde(remote = "NonBusinessDay", rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum NonBusinessDayWire {
    Previous,
    Next,
}
#[derive(Deserialize, Serialize)]
#[serde(remote = "ProrationBasis", rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ProrationWire {
    CalendarDays,
    ScheduledWorkdays,
}
#[derive(Deserialize, Serialize)]
#[serde(remote = "PaymentChannel", rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ChannelWire {
    AttestationOnly,
    FileGeneric,
}
#[derive(Deserialize, Serialize)]
#[serde(remote = "PayDateRule", deny_unknown_fields)]
pub(crate) struct PayDateWire {
    #[serde(with = "pay_day")]
    day: PayDay,
    month_offset: u8,
    #[serde(with = "NonBusinessDayWire")]
    non_business_day: NonBusinessDay,
}
#[derive(Deserialize, Serialize)]
#[serde(remote = "PeriodRule", deny_unknown_fields)]
pub(crate) struct PeriodWire {
    #[serde(with = "period_start")]
    start_day: PeriodStart,
    month_offset: i8,
}
