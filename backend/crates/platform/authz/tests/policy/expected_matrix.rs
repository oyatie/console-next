//! The inherited permission matrix the `policy` tests pin, one row per
//! `Feature`. Split out of `policy.rs` to keep it under its file-size pin.

use console_platform_authz::{Feature, PermissionLevel};

pub(crate) fn expected_matrix() -> [(Feature, [PermissionLevel; 6]); 110] {
    use Feature::{
        AiAssist, ApprovalFinalize, ApprovalRouteManage, AssigneeManage, AuditLogRead,
        AuditStreamAccessLogRead, AuditStreamRead, BenefitCatalogManage, BenefitCatalogRead,
        BranchManage, ChangeRequestDecide, CompletionReview, ComplianceDomainManage,
        ComplianceDomainRead, ComplianceEvidenceLink, ConsultingManage, ConsultingRead,
        DailyPlanRequest, DailyPlanReview, ElevatedRoleGrant, EmployeeDirectoryManage,
        EmployeeDirectoryRead, Equipment3rApprove, Equipment3rAssess, Equipment3rDispatch,
        Equipment3rDisposition, Equipment3rInspect, Equipment3rObserve, Equipment3rQuote,
        Equipment3rRegistry, EquipmentCostLedgerRead, EquipmentCostLedgerWrite, EquipmentManage,
        EvaluationManage, EvaluationRead, EvaluationSubmit, EvidenceAttach, ExcelDownload,
        ExceptionDecide, ExitCaseHqConfirm, ExitCaseHrConfirm, ExitCaseReport,
        ExitSettlementManage, FacilitiesAccept, FacilitiesDispatch, FacilitiesExecute,
        FacilitiesManage, FacilitiesObserve, InspectionRoundComplete, InspectionScheduleManage,
        IntegrityFindingTriage, IntegrityFindingsRead, InventoryConsume, InventoryManage,
        InventoryRead, InventoryReorder, JobTitleManage, KpiExclusionManage, KpiRead,
        LegalEntityManage, LifecycleManage, Login, LogisticsDispatch, LogisticsPickPack,
        LogisticsPod, LogisticsPutaway, LogisticsReceive, LogisticsRelease, LogisticsSettle,
        MailAccountManage, MailUse, MasterListImport, NoticeManage, OpsDashboardRead,
        OrgChangeApply, OrgChangeApprove, OrgChangeDraft, OrgChangeRead, OrgUnitManage,
        OrgWideQueueTriage, PayrollRunManage, PayrollRunRead, PeriodLockManage, PriorityManage,
        ProductionSourceIngest, PurchaseExecute, PurchaseFinalApprove, PurchaseRequestApprove,
        PurchaseRequestCreate, PurchaseRequestRead, ReasonCodeManage, RecruitingManage,
        RecruitingRead, RegionManage, RentalQuoteManage, RetainedRecordsRead, RoleManage,
        SalesManage, SettingsManage, SubordinateUserCreate, TargetManage, TenantOffboard,
        UserManage, WorkOrderCreate, WorkOrderEditIntake, WorkOrderReadAll, WorkOrderStart,
        WorkReportSubmit,
    };
    use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

    // Column order: [MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE, SUPER_ADMIN].
    // MEMBER (open-signup default) is default-DENY everywhere but `Login`.
    [
        (Login, [A, A, A, A, A, A]),
        (WorkOrderCreate, [D, A, L, A, L, A]),
        (WorkOrderEditIntake, [D, A, L, A, L, A]),
        (WorkOrderReadAll, [D, A, A, A, A, A]),
        (WorkOrderStart, [D, L, A, A, L, A]),
        (WorkReportSubmit, [D, L, A, A, L, A]),
        (EvidenceAttach, [D, A, A, A, L, A]),
        (PriorityManage, [D, D, D, A, D, A]),
        (AssigneeManage, [D, D, D, A, D, A]),
        (TargetManage, [D, D, R, A, D, A]),
        (CompletionReview, [D, D, D, A, D, A]),
        (ApprovalFinalize, [D, D, D, A, A, A]),
        (DailyPlanRequest, [D, D, A, A, D, A]),
        (DailyPlanReview, [D, D, D, A, D, A]),
        // Org-wide queue triage read: EXECUTIVE + SUPER_ADMIN only (a branch
        // ADMIN stays confined to its branch scope), matching the org-wide tier
        // of resolve_branch_scope_in_org.
        (OrgWideQueueTriage, [D, D, D, D, A, A]),
        (KpiRead, [D, D, D, A, A, A]),
        (KpiExclusionManage, [D, D, D, A, A, A]),
        (UserManage, [D, D, D, A, D, A]),
        (SubordinateUserCreate, [D, D, D, L, D, A]),
        (ElevatedRoleGrant, [D, D, D, D, D, A]),
        (RoleManage, [D, D, D, D, D, A]),
        (RegionManage, [D, D, D, A, A, A]),
        (BranchManage, [D, D, D, A, A, A]),
        (EquipmentManage, [D, D, D, A, A, A]),
        (MasterListImport, [D, D, D, A, D, A]),
        (RentalQuoteManage, [D, A, D, A, A, A]),
        (EquipmentCostLedgerRead, [D, D, D, A, A, A]),
        (EquipmentCostLedgerWrite, [D, D, D, A, D, A]),
        (PurchaseRequestCreate, [D, A, R, A, D, A]),
        (PurchaseRequestRead, [D, A, L, A, A, A]),
        (PurchaseRequestApprove, [D, D, D, A, D, A]),
        (PurchaseFinalApprove, [D, D, D, D, A, A]),
        (PurchaseExecute, [D, A, D, A, D, A]),
        (InspectionScheduleManage, [D, D, D, A, D, A]),
        (InspectionRoundComplete, [D, D, A, A, D, A]),
        (AuditLogRead, [D, D, D, A, D, A]),
        (ExcelDownload, [D, A, A, A, A, A]),
        (OpsDashboardRead, [D, D, D, A, D, A]),
        (SalesManage, [D, D, D, A, A, A]),
        // Logistics is explicit-grant only: no built-in role fallback.
        (LogisticsReceive, [D, D, D, D, D, D]),
        (LogisticsPutaway, [D, D, D, D, D, D]),
        (LogisticsRelease, [D, D, D, D, D, D]),
        (LogisticsPickPack, [D, D, D, D, D, D]),
        (LogisticsDispatch, [D, D, D, D, D, D]),
        (LogisticsPod, [D, D, D, D, D, D]),
        (LogisticsSettle, [D, D, D, D, D, D]),
        // IV inventory is branch-operational: front-office/mechanics may read,
        // mechanics/admins may consume, and management/reorder is admin-tier.
        (InventoryRead, [D, A, A, A, A, A]),
        (InventoryManage, [D, D, D, A, D, A]),
        (InventoryConsume, [D, D, A, A, D, A]),
        (InventoryReorder, [D, D, D, A, D, A]),
        // Benefit catalog is HR compensation reference data — mirrors the HR
        // EmployeeDirectory tier (the closest analogous feature): read is admin +
        // leadership (ADMIN/EXECUTIVE/SUPER_ADMIN), management is the HR-config
        // authority (ADMIN/SUPER_ADMIN). Values match the authoritative
        // `permission_matrix` in lib.rs.
        (BenefitCatalogRead, [D, D, D, A, A, A]),
        (BenefitCatalogManage, [D, D, D, A, D, A]),
        // Compliance domain is branch-operational for scoped obligations but
        // the REST boundary independently requires org-wide scope for tenant
        // catalog objects. Evidence linking is a distinct audited capability.
        (ComplianceDomainRead, [D, D, D, A, A, A]),
        (ComplianceDomainManage, [D, D, D, A, D, A]),
        (ComplianceEvidenceLink, [D, D, D, A, D, A]),
        // Consulting is capability-driven from its first slice.
        (ConsultingRead, [D, D, D, D, D, D]),
        (ConsultingManage, [D, D, D, D, D, D]),
        // Keep the historical wire key, but v1 has no AI runtime authority.
        (AiAssist, [D, D, D, D, D, D]),
        // Integrity findings are labor-law sensitive: EXECUTIVE + SUPER_ADMIN only.
        (IntegrityFindingsRead, [D, D, D, D, A, A]),
        (IntegrityFindingTriage, [D, D, D, D, A, A]),
        // Webmail: configuring the mailbox is ADMIN + SUPER_ADMIN (holds the
        // mail secrets); sending is front-office + leadership (no MECHANIC).
        (MailAccountManage, [D, D, D, A, D, A]),
        (MailUse, [D, A, D, A, A, A]),
        (EmployeeDirectoryRead, [D, D, D, A, A, A]),
        (EmployeeDirectoryManage, [D, D, D, A, D, A]),
        // Absence → exit → settlement separation of duties. Report / HR confirm /
        // settlement are the branch HR-manager tier (ADMIN + SUPER_ADMIN); HQ
        // confirm is the org-wide leadership tier (EXECUTIVE + SUPER_ADMIN),
        // mirroring OrgWideQueueTriage. The confirm handler's distinct-actor rule
        // still forbids one person from performing both confirmation tiers.
        (ExitCaseReport, [D, D, D, A, D, A]),
        (ExitCaseHrConfirm, [D, D, D, A, D, A]),
        (ExitCaseHqConfirm, [D, D, D, D, A, A]),
        (ExitSettlementManage, [D, D, D, A, D, A]),
        (Feature::AttendanceExceptionManage, [D, D, D, A, D, A]),
        (Feature::AttendanceSubstitutionManage, [D, D, D, A, D, A]),
        // Covert audit stream actions are Cedar clearance-only: the legacy
        // role matrix intentionally denies every built-in role.
        (AuditStreamRead, [D, D, D, D, D, D]),
        (AuditStreamAccessLogRead, [D, D, D, D, D, D]),
        // BE-LC: period close authority (ADMIN + EXECUTIVE + SUPER_ADMIN) and
        // lifecycle/records management (ADMIN + SUPER_ADMIN).
        (PeriodLockManage, [D, D, D, A, A, A]),
        (LifecycleManage, [D, D, D, A, D, A]),
        // Payroll draft-run/line staging read: same tier as
        // EmployeeDirectoryRead (financial/HR-sensitive).
        (PayrollRunManage, [D, D, D, A, A, A]),
        (PayrollRunRead, [D, D, D, A, A, A]),
        // Notice-board publish tier: ADMIN + EXECUTIVE + SUPER_ADMIN.
        (NoticeManage, [D, D, D, A, A, A]),
        (FacilitiesManage, [D, D, D, A, D, A]),
        (FacilitiesDispatch, [D, D, D, A, D, A]),
        (FacilitiesExecute, [D, D, A, A, D, A]),
        (FacilitiesAccept, [D, D, D, A, D, A]),
        (FacilitiesObserve, [D, A, A, A, A, A]),
        (ProductionSourceIngest, [D, D, D, D, D, D]),
        // Equipment 3R: capability-driven, custom-grant only.
        (Equipment3rRegistry, [D, D, D, D, D, D]),
        (Equipment3rQuote, [D, D, D, D, D, D]),
        (Equipment3rApprove, [D, D, D, D, D, D]),
        (Equipment3rDispatch, [D, D, D, D, D, D]),
        (Equipment3rInspect, [D, D, D, D, D, D]),
        (Equipment3rAssess, [D, D, D, D, D, D]),
        (Equipment3rDisposition, [D, D, D, D, D, D]),
        (Equipment3rObserve, [D, D, D, D, D, D]),
        // Recruiting mirrors the HR directory pair (HR-owned data, EXECUTIVE
        // read-only) and is gated org-wide like EmployeeDirectory*.
        (RecruitingRead, [D, D, D, A, A, A]),
        (RecruitingManage, [D, D, D, A, D, A]),
        (EvaluationRead, [D, D, D, A, A, A]),
        (EvaluationManage, [D, D, D, A, D, A]),
        (EvaluationSubmit, [D, D, D, A, A, A]),
        (OrgChangeRead, [D, D, D, A, A, A]),
        (OrgChangeDraft, [D, D, D, A, A, A]),
        (OrgChangeApprove, [D, D, D, D, A, A]),
        (OrgChangeApply, [D, D, D, D, A, A]),
        // PREREG-2: Cedar-only, the legacy matrix grants nobody.
        (SettingsManage, [D, D, D, D, D, D]),
        (ReasonCodeManage, [D, D, D, D, D, D]),
        (ExceptionDecide, [D, D, D, D, D, D]),
        (ApprovalRouteManage, [D, D, D, D, D, D]),
        (ChangeRequestDecide, [D, D, D, D, D, D]),
        (JobTitleManage, [D, D, D, D, D, D]),
        (RetainedRecordsRead, [D, D, D, D, D, D]),
        (TenantOffboard, [D, D, D, D, D, D]),
        // decisions #14.2: Cedar-only (`legal_entity_manage` action schema).
        (LegalEntityManage, [D, D, D, D, D, D]),
        // CRUD: Cedar-only (`org_unit_manage` action schema).
        (OrgUnitManage, [D, D, D, D, D, D]),
    ]
}
