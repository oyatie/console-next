// SPDX-License-Identifier: LicenseRef-Proprietary
//! Vendor ceilings; tenant overrides remain disabled until governed settings writes ship.
macro_rules! support { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    SupportRequestExpiry => "support.request_expiry" = D::int(Hours, Some(1), Some(12), 12, Higher).governed(Governance::PlatformOnly);
    SupportMaxDuration => "support.max_duration" = D::int(Hours, Some(1), Some(4), 4, Higher).governed(Governance::PlatformOnly);
] $($rest)* } }; }
