//! PA-ENT keys (decisions #15.2). Append-only; see `keys/mod.rs`.

macro_rules! pa_ent { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // decisions #15.2: a scope grant on a legal entity that does not employ the holder
    // needs its processing-entrustment basis, which feeds that legal entity's entrustee list.
    AuthzCrossEntityGrantBasisRequired => "authz.cross_entity_grant.basis_required" = D::bool(true, Lower).cited(PIPA_26_2);
] $($rest)* } }; }
