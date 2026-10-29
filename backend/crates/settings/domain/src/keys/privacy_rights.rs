// SPDX-License-Identifier: LicenseRef-Proprietary
//! Objection review is an operational clock, not a statutory deadline.
macro_rules! privacy_rights { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    PrivacyRightsObjectionReviewDays => "privacy.rights.objection_review_days" = D::int(Days, Some(1), Some(30), 10, Higher).cited(crate::keys::privacy_rights::PIPA_38_5);
] $($rest)* } }; }

// shortcut: citations.rs is lane-owned; move this source there after its owner lands.
pub(super) const PIPA_38_5: console_kernel_core::OfficialSource =
    console_kernel_core::OfficialSource {
        authority: "Personal Information Protection Commission",
        title: "개인정보 보호법 제38조제5항 (법정 기한 없음 · 운영 기준)",
        url: "https://www.law.go.kr/법령/개인정보보호법/제38조",
        retrieved_on: time::macros::date!(2026 - 10 - 27),
    };
