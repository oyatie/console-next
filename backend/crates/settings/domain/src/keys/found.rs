//! FOUND (F-SET BW-00) keys: decisions Appendix A, the #10 retention table
//! and BW-09. Append-only; see `keys/mod.rs`.

macro_rules! found { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // --- approvals (#1, #2, #11) ---
    ApprovalOverdueEscalateAfterBusinessDays => "approval.overdue.escalate_after_business_days" = D::int(BusinessDays, Some(1), None, 2, Higher);
    ApprovalDelegationMaxDays => "approval.delegation.max_days" = D::int(Days, Some(1), Some(90), 30, Higher);
    ApprovalReturnedReminderDays => "approval.returned.reminder_days" = D::int(Days, Some(1), None, 3, Higher);
    ApprovalRegisteredBranchChangeRequiresGoverningBody => "approval.doc_class.registered_branch_change.requires_governing_body_decision" = D::bool(true, Lower).governed(Governance::Fixed).cited(COMMERCIAL_ACT_393);
    ApprovalRegisteredManagerAppointmentRequiresGoverningBody => "approval.doc_class.registered_manager_appointment.requires_governing_body_decision" = D::bool(true, Lower).governed(Governance::Fixed).cited(COMMERCIAL_ACT_393);
    CorporateSmallCompany383Proviso => "corporate.small_company_383_proviso" = D::bool_fact(Higher).cited(COMMERCIAL_ACT_383);

    // --- exits (#4, #8a, BW-09) ---
    ExitDateBackdateSoftDays => "exit.date.backdate_soft_days" = D::int(Days, Some(3), Some(14), 14, Higher);
    ExitDateFutureSoftDays => "exit.date.future_soft_days" = D::int(Days, Some(30), Some(365), 90, Higher);
    ExitDateUnknownResolveDays => "exit.date_unknown.resolve_days" = D::int(Days, Some(1), Some(14), 7, Higher);
    ExitHqReviewLeadDays => "exit.hq_review.lead_days" = D::int(Days, Some(1), Some(30), 5, Lower);
    ExitHqReviewPostApplyDays => "exit.hq_review.post_apply_days" = D::int(Days, Some(1), Some(30), 7, Higher);
    ExitAccessRevokeModeVoluntary => "exit.access.revoke_mode.voluntary" = D::code(REVOKE_MODES, "END_OF_EXIT_DATE", Higher);
    ExitAccessRevokeModeInvoluntary => "exit.access.revoke_mode.involuntary" = D::code(REVOKE_MODES, "ON_CONFIRM", Higher);
    ExitAccessHandoverMaxDays => "exit.access.handover_max_days" = D::int(Days, Some(0), Some(30), 30, Higher);
    ExitAccessSelfServiceDays => "exit.access.self_service_days" = D::int(Days, Some(30), Some(1095), 90, Higher);
    ExitSettlementWageDeviationPct => "exit.settlement.wage_deviation_pct" = D::int(Percent, Some(0), Some(10), 1, Higher);

    // --- data periods (#5, #8a, #8b) ---
    LifecycleBackdateSoftFloorDays => "lifecycle.backdate_soft_floor_days" = D::int(Days, Some(0), Some(90), 30, Higher);
    ExceptionsApprovalTtlDays => "exceptions.approval_ttl_days" = D::int(Days, Some(1), Some(30), 14, Higher);
    WithholdingFilingCadence => "withholding.filing_cadence" = D::code_fact(FILING_CADENCES).cited(INCOME_TAX_ACT_128);
    PeriodLockUnlockMaxDays => "period_lock.unlock_max_days" = D::int(Days, Some(1), Some(14), 7, Higher);

    // --- sign-in and two-person controls (#7, #8c) ---
    AuthIdleTimeoutMinutes => "auth.idle_timeout_minutes" = D::int(Minutes, Some(5), Some(60), 30, Higher).cited(NIST_800_63B_4);
    AuthzSoleHolderMode => "authz.sole_holder.mode" = D::code(SOLE_HOLDER_MODES, "step_up_notice_review", Higher);
    AuthzElevatedGrantSoleAdminDelay => "authz.elevated_grant.sole_admin_delay" = D::int(Hours, Some(24), Some(168), 24, Lower);
    AuthzSecondPersonMinGrantAge => "authz.second_person.min_grant_age" = D::int(Days, Some(1), Some(30), 7, Lower);
    AuthzSecondPersonResponseDue => "authz.second_person.response_due" = D::int(Hours, Some(1), Some(120), 48, Higher);
    SecurityContactReverifyInterval => "security_contact.reverify_interval" = D::int(Months, Some(1), Some(12), 12, Higher).cited(SAFETY_MEASURES_NOTICE_4);
    ReviewSoleHolderExceptionDue => "review.sole_holder_exception.due" = D::int(Days, Some(1), Some(90), 30, Higher);
    AuditPermissionChangeRetention => "audit.permission_change.retention" = retention_years(3).cited(SAFETY_MEASURES_NOTICE_5);
    AuditAccessLogRetention => "audit.access_log.retention" = retention_years(2).cited(SAFETY_MEASURES_NOTICE_8);

    // --- offboarding and privacy (#10) ---
    OffboardingCoolingPeriod => "offboarding.cooling_period" = D::int(Days, Some(3), None, 7, Lower);
    OffboardingRetrievalWindow => "offboarding.retrieval_window" = D::int(Days, Some(30), None, 60, Lower);
    OffboardingDestroyAfterDue => "offboarding.destroy_after_due" = D::int(Days, Some(0), Some(5), 5, Higher).cited(STANDARD_PRIVACY_GUIDELINE_10);
    OffboardingArchiveServiceEnabled => "offboarding.archive_service.enabled" = D::bool(false, Neutral).governed(Governance::PlatformOnly);
    BackupArchiveTail => "backup.archive_tail" = D::int(Days, None, None, 35, Neutral).governed(Governance::ReadOnly);
    PrivacyExitProcessingOverdueAfter => "privacy.exit_processing_overdue_after" = D::int(Days, Some(1), Some(180), 90, Higher);

    // --- retention classes (#10; the customer's duty, raise only) ---
    RetentionLaborEmployeeRegister => "retention.labor.employee_register" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborEmploymentContract => "retention.labor.employment_contract" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborWageLedger => "retention.labor.wage_ledger" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborWageBasis => "retention.labor.wage_basis" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborHireExit => "retention.labor.hire_exit" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborPromotionPayChange => "retention.labor.promotion_pay_change" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborLeave => "retention.labor.leave" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborWrittenAgreements => "retention.labor.written_agreements" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionLaborMinorProof => "retention.labor.minor_proof" = retention_years(3).cited(LABOR_STANDARDS_DECREE_22);
    RetentionTaxBooksEvidence => "retention.tax.books_evidence" = retention_years(5).cited(BASIC_NATIONAL_TAX_ACT_85_3);
    RetentionNhisEmployerDocs => "retention.nhis.employer_docs" = retention_years(3).cited(HEALTH_INSURANCE_ACT_96_4);
    RetentionNpsMemberNoticeProof => "retention.nps.member_notice_proof" = retention_years(5);
    RetentionEqualityDocs => "retention.equality.docs" = retention_years(3);
    RetentionEqualityGrievance => "retention.equality.grievance" = retention_years(3);
    RetentionSeveranceInterimProof => "retention.severance.interim_proof" = retention_years(5);
    RetentionSafetyDocs => "retention.safety.docs" = retention_years(3);
    // The 채용절차법 §11 period is unverified [U]: a fact the tenant declares
    // until ST-1 confirms a statutory floor.
    RetentionRecruitingDocs => "retention.recruiting.docs" = D::int_fact(Days, Lower);
] $($rest)* } }; }
