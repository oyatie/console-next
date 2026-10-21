//! BE-MIG keys (walkthrough W11, decisions #28). Append-only; see `keys/mod.rs`.

macro_rules! mig { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Most candidate rows one employee import may plan and apply (422 import_row_limit above it).
    ImportApplyMaxRows => "import.apply.max_rows" = D::int(Count, Some(100), Some(3_000), 2_000, Higher);
] $($rest)* } }; }
