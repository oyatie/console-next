// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared register pagination policy.
macro_rules! display { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    HrContractSoonDays => "hr.contract_soon_days" = D::int(Days, Some(1), Some(365), 60, Higher);
    DisplayPageSize => "display.page_size" = D::int(Count, Some(1), Some(500), 100, Higher);
] $($rest)* } }; }
