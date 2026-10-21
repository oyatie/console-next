//! PEOPLE-A (MR-26) keys: 등록 취소 after 운영 시작 (onboarding design §7.3,
//! §13). Append-only; see `keys/mod.rs`.

macro_rules! people_a { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // A started registration may be voided only while younger than this.
    PeopleVoidWindow => "people.void_window" = D::int(Days, Some(1), Some(30), 14, Higher);
    // A voided record's personal data is destroyed after this many days.
    PeopleVoidPiiRetention => "people.void_pii_retention" = D::int(Days, Some(0), Some(30), 30, Higher).cited(STANDARD_PRIVACY_GUIDELINE_10);
] $($rest)* } }; }
