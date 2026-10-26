// SPDX-License-Identifier: LicenseRef-Proprietary
//! Governed reveal display duration (SEC-01).
macro_rules! privacy_reveal { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Seconds on screen (SEC-01); independent of the five-minute passkey proof lifetime.
    PrivacyRevealDisplaySeconds => "privacy.reveal_display_seconds" = D::int(Count, Some(15), Some(60), 60, Higher);
    PrivacyRevealRatePerHour => "privacy.reveal_rate_per_hour" = D::int(Count, Some(5), Some(100), 20, Higher);
] $($rest)* } }; }
