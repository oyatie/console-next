// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared display policy.
/// Console product owns this read-only code default; consumers use it directly while overrides are disabled.
/// Legal deadlines remain in the statutory register.
pub const DEADLINE_DUE_SOON_DAYS: i64 = 7;
macro_rules! display { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    HrContractSoonDays => "hr.contract_soon_days" = D::int(Days, Some(1), Some(365), 60, Higher);
    DeadlineDueSoonDays => "display.deadline_due_soon_days" = D::int(Days, Some(0), Some(365), crate::keys::DEADLINE_DUE_SOON_DAYS, Neutral).governed(Governance::ReadOnly);
    DisplayPageSize => "display.page_size" = D::int(Count, Some(1), Some(500), 100, Higher);
] $($rest)* } }; }
