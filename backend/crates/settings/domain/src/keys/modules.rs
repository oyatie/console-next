// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant module activation defaults; effective-dated overrides remain authoritative.
macro_rules! modules { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    ModuleBenefitsEnabled => "module.benefits.enabled" = D::bool(true, Neutral).scope_ceiling(crate::definition::ScopeCeiling::Tenant);
    ModuleConsultingEnabled => "module.consulting.enabled" = D::bool(true, Neutral).scope_ceiling(crate::definition::ScopeCeiling::Tenant);
    ModuleCalendarEnabled => "module.calendar.enabled" = D::bool(true, Neutral).scope_ceiling(crate::definition::ScopeCeiling::Tenant);
    ModuleEvaluationEnabled => "module.evaluation.enabled" = D::bool(true, Neutral).scope_ceiling(crate::definition::ScopeCeiling::Tenant);
    ModulePayrollEnabled => "module.payroll.enabled" = D::bool(true, Neutral);
] $($rest)* } }; }
