//! D26 (decisions #26) keys: the approval policy of each change class that has an
//! approval route in the code. `none` (the pilot default) applies the change
//! directly, or on its effective date, with its audit row and its correction/revert path;
//! `route` keeps the approval route. Append-only; see `keys/mod.rs`.

macro_rules! d26 { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Org-change proposal: `route` = the ordered approval steps.
    ApprovalPolicyOrgStructure => "approval.policy.org_structure" = D::code(APPROVAL_POLICIES, "none", Higher);
    // HR data correction of a high-risk field (PATCH and bulk): `route` = a second person.
    ApprovalPolicyPeopleCorrection => "approval.policy.people_correction" = D::code(APPROVAL_POLICIES, "none", Higher);
    // Same-name identity merge: `route` = a second person.
    ApprovalPolicyIdentityMerge => "approval.policy.identity_merge" = D::code(APPROVAL_POLICIES, "none", Higher);
    // Registration void after go-live: `route` = a second person.
    ApprovalPolicyRegistrationVoid => "approval.policy.registration_void" = D::code(APPROVAL_POLICIES, "none", Higher);
    // Exit confirmation: `route` = the HQ tier is a different person than the HR tier.
    ApprovalPolicyExit => "approval.policy.exit" = D::code(APPROVAL_POLICIES, "none", Higher);
    ApprovalPolicyImportRollback => "approval.policy.import_rollback" = D::code(APPROVAL_POLICIES, "none", Higher);
    ApprovalBulkOrgStructure => "approval.bulk.org_structure" = D::bool(false, Higher);
    ApprovalBulkPeopleCorrection => "approval.bulk.people_correction" = D::bool(false, Higher);
    ApprovalBulkIdentityMerge => "approval.bulk.identity_merge" = D::bool(false, Higher);
    ApprovalBulkImportRollback => "approval.bulk.import_rollback" = D::bool(false, Higher);
    ApprovalStepUpOrgStructure => "approval.step_up.org_structure" = D::bool(false, Lower);
    ApprovalStepUpPeopleCorrection => "approval.step_up.people_correction" = D::bool(false, Lower);
    ApprovalStepUpIdentityMerge => "approval.step_up.identity_merge" = D::bool(false, Lower);
    ApprovalStepUpImportRollback => "approval.step_up.import_rollback" = D::bool(false, Lower);
    ApprovalBulkRegistrationVoid => "approval.bulk.registration_void" = D::bool(false, Higher);
    ApprovalStepUpRegistrationVoid => "approval.step_up.registration_void" = D::bool(false, Lower);
] $($rest)* } }; }
