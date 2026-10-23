// SPDX-License-Identifier: LicenseRef-Proprietary
//! Calendar policy inherits from the tenant unless the legal entity overrides it.
include!(concat!(env!("OUT_DIR"), "/time_zones.rs"));
macro_rules! calendar { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    CalendarTimeZone => "calendar.time_zone" = D::code(calendar::TIME_ZONES, "Asia/Seoul", Neutral);
] $($rest)* } }; }
