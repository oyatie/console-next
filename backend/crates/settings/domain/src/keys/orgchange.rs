// SPDX-License-Identifier: LicenseRef-Proprietary
//! Minutes after the platform business day's midnight; neither clock direction loosens a control.
macro_rules! orgchange { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    OrgChangeApplyTime => "orgchange.apply_time" = D::int(Minutes, Some(0), Some(1439), 5, Neutral);
] $($rest)* } }; }
