// SPDX-License-Identifier: LicenseRef-Proprietary
//! Governed operator recovery: two people, a tenant cancellation window and a short code.
macro_rules! ops_recovery { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    PlatformTenantEraseCooling => "platform.tenant_erase_cooling" = D::int(Hours, Some(24), Some(168), 72, Lower).governed(Governance::PlatformOnly);
    OpsRecoveryHoldHours => "ops_recovery.hold_hours" = D::int(Hours, Some(24), Some(168), 72, Lower).governed(Governance::PlatformOnly);
    OpsRecoveryCodeTtlMinutes => "ops_recovery.code_ttl_minutes" = D::int(Minutes, Some(5), Some(10), 10, Higher).governed(Governance::PlatformOnly).cited(NIST_800_63B_4);
] $($rest)* } }; }
