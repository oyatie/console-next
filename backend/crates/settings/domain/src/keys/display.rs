// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared register pagination policy.
macro_rules! display { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    DisplayPageSize => "display.page_size" = D::int(Count, Some(1), Some(500), 100, Higher);
] $($rest)* } }; }
