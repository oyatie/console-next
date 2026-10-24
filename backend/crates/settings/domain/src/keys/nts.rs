// SPDX-License-Identifier: LicenseRef-Proprietary
//! Authority checks: proposed operator defaults, tenant overrides forbidden.
macro_rules! nts { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    NtsCheckCadenceHours => "nts.check.cadence_hours" = D::int(Hours, Some(1), Some(720), 24, Neutral).governed(Governance::PlatformOnly);
    NtsCheckBatchSize => "nts.check.batch_size" = D::int(Count, Some(1), Some(100), 100, Neutral).governed(Governance::PlatformOnly);
    NtsCheckDailyBudget => "nts.check.daily_budget" = D::int(Count, Some(1), Some(1_000_000), 10_000, Neutral).governed(Governance::PlatformOnly);
    NtsCheckReflectionLagDays => "nts.check.reflection_lag_days" = D::int(Days, Some(2), Some(2), 2, Neutral).governed(Governance::Fixed);
    NtsCheckBackoffSeconds => "nts.check.backoff_seconds" = D::int(Count, Some(60), Some(86400), 3600, Neutral).governed(Governance::PlatformOnly);
] $($rest)* } }; }
