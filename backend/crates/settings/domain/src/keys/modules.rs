// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant module activation defaults; effective-dated overrides remain authoritative.
macro_rules! modules { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    ModulePayrollEnabled => "module.payroll.enabled" = D::bool(true, Neutral);
] $($rest)* } }; }
