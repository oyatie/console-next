// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant module activation; closed modules stay inactive until explicitly enabled.
macro_rules! modules { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    ModulePayrollEnabled => "module.payroll.enabled" = D::bool_fact(Neutral);
] $($rest)* } }; }
