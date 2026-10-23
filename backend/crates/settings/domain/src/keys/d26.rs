//! D26 (decisions #26) keys: the 결재 policy of each change class that has an
//! approval route in the code. `none` (the pilot default) applies the change
//! directly, or on its 시행일, with its audit row and its 정정/되돌리기 path;
//! `route` keeps the approval route. Append-only; see `keys/mod.rs`.

macro_rules! d26 { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // 조직 개편 (org-change proposal): `route` = the ordered approval steps.
    ApprovalPolicyOrgStructure => "approval.policy.org_structure" = D::code(APPROVAL_POLICIES, "none", Higher);
    // 인사 정보 정정 of a high-risk field (PATCH and bulk): `route` = a second person.
    ApprovalPolicyPeopleCorrection => "approval.policy.people_correction" = D::code(APPROVAL_POLICIES, "none", Higher);
    // 동명이인 병합 (identity merge): `route` = a second person.
    ApprovalPolicyIdentityMerge => "approval.policy.identity_merge" = D::code(APPROVAL_POLICIES, "none", Higher);
    // 등록 취소 after 운영 시작: `route` = a second person.
    ApprovalPolicyRegistrationVoid => "approval.policy.registration_void" = D::code(APPROVAL_POLICIES, "none", Higher);
    // 퇴직 확인: `route` = the HQ tier is a different person than the HR tier.
    ApprovalPolicyExit => "approval.policy.exit" = D::code(APPROVAL_POLICIES, "none", Higher);
    ApprovalPolicyImportRollback => "approval.policy.import_rollback" = D::code(APPROVAL_POLICIES, "none", Higher);
] $($rest)* } }; }
