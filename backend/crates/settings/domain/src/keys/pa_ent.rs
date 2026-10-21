//! PA-ENT keys (decisions #15.2). Append-only; see `keys/mod.rs`.

macro_rules! pa_ent { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // decisions #15.2: a scope grant on a 법인 that does not employ the holder
    // needs its 업무위탁 basis, which feeds that 법인's 수탁자 list.
    AuthzCrossEntityGrantBasisRequired => "authz.cross_entity_grant.basis_required" = D::bool(true, Lower).cited(PIPA_26_2);
] $($rest)* } }; }
