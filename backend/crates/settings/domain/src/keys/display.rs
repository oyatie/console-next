// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared display policy.
/// Console product owns the display policy; operators may set an effective-dated platform value.
/// Legal deadlines remain in the statutory register.
macro_rules! display { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    HrContractSoonDays => "hr.contract_soon_days" = D::int(Days, Some(1), Some(365), 60, Higher);
    DeadlineDueSoonDays => "display.deadline_due_soon_days" = D::int(Days, Some(0), Some(365), 7, Neutral).governed(Governance::PlatformOnly);
    DisplayPageSize => "display.page_size" = D::int(Count, Some(1), Some(500), 100, Higher);
] $($rest)* } }; }
