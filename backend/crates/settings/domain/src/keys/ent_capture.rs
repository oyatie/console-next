//! ENT-CAPTURE keys (entity design §5). Append-only; see `keys/mod.rs`.

macro_rules! ent_capture { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Business registration certificate originals: the 5-year floor runs from supersession
    // (entity design §5) [J]; Commercial Act §33 (10 years) is the stricter option a tenant
    // may raise to.
    RetentionEntityRegistrationDocument => "retention.entity_registration_document" = retention_years(5).cited(BASIC_NATIONAL_TAX_ACT_85_3);
] $($rest)* } }; }
