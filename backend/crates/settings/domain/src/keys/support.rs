// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant support limits may only tighten the registry ceilings.
macro_rules! support { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    SupportRequestExpiry => "support.request_expiry" = D::int(Hours, Some(1), Some(12), 12, Higher);
    SupportMaxDuration => "support.max_duration" = D::int(Hours, Some(1), Some(4), 4, Higher);
] $($rest)* } }; }
