mod matrix;
mod names;

/// Feature/action rows from the inherited permission matrix.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Login,
    WorkOrderCreate,
    WorkOrderEditIntake,
    WorkOrderReadAll,
    WorkOrderStart,
    WorkReportSubmit,
    EvidenceAttach,
    PriorityManage,
    AssigneeManage,
    TargetManage,
    CompletionReview,
    /// Delegate finalization for generalized approval documents. Author
    /// finalization is owner-checked by the workflow runtime; delegate mode uses
    /// this policy gate and records the inert Cedar shadow.
    ApprovalFinalize,
    DailyPlanRequest,
    DailyPlanReview,
    /// Org-wide read of the work-order + daily-plan queues regardless of branch
    /// membership. EXECUTIVE + SUPER_ADMIN only — it widens triage visibility to
    /// every branch in the tenant (RLS still confines it to the caller's org),
    /// matching [`resolve_branch_scope_in_org`]'s org-wide tier. A branch-scoped
    /// ADMIN stays confined to its branches. The future "org-admin" custom role
    /// will hold this capability (see docs/specs/rbac-configurable.md).
    ///
    /// [`resolve_branch_scope_in_org`]: crate::resolve_branch_scope_in_org
    OrgWideQueueTriage,
    KpiRead,
    KpiExclusionManage,
    UserManage,
    SubordinateUserCreate,
    ElevatedRoleGrant,
    /// Define tenant-owned custom role policies. Initially SUPER_ADMIN-only;
    /// custom role assignment/effective-policy publication is held behind the
    /// policy-studio safety gates in docs/specs/rbac-configurable.md.
    RoleManage,
    /// Create/rename regions (지역) during org setup.
    RegionManage,
    /// Create/rename branches (지점) during org setup.
    BranchManage,
    /// Create/update/soft-delete equipment master rows (지게차) outside the
    /// bulk master-list import path.
    EquipmentManage,
    MasterListImport,
    RentalQuoteManage,
    EquipmentCostLedgerRead,
    EquipmentCostLedgerWrite,
    PurchaseRequestCreate,
    PurchaseRequestRead,
    PurchaseRequestApprove,
    PurchaseFinalApprove,
    PurchaseExecute,
    InspectionScheduleManage,
    InspectionRoundComplete,
    AuditLogRead,
    ExcelDownload,
    /// Read the per-tenant operational dashboard (work-order funnel, SLA risk,
    /// utilization, equipment/substitution rollups). The current route is an
    /// org-wide picture with no branch filter and therefore also passes through
    /// `authorize_org_wide`; that makes SUPER_ADMIN the only built-in role that
    /// satisfies both gates. The ADMIN matrix cell is retained for a future
    /// branch-filtered projection, not authority over today's tenant-wide route.
    OpsDashboardRead,
    /// Manage the public sales catalog (#6 지게차 매매): create/update/withdraw
    /// used-forklift listings and triage inbound customer inquiries. ADMIN tier.
    SalesManage,
    /// Receive an advance shipping notice and record warehouse receipt
    /// exceptions. Custom-grant only: no built-in role fallback.
    LogisticsReceive,
    /// Complete governed putaway into a warehouse stock location. Custom-grant
    /// only: no built-in role fallback.
    LogisticsPutaway,
    /// Release a fulfillment order and reserve available stock. Custom-grant
    /// only: no built-in role fallback.
    LogisticsRelease,
    /// Pick and pack released inventory. Custom-grant only: no built-in role
    /// fallback.
    LogisticsPickPack,
    /// Dispatch a packed shipment through its assigned carrier/vehicle leg.
    /// Custom-grant only: no built-in role fallback.
    LogisticsDispatch,
    /// Record recipient-confirmed proof of delivery with immutable evidence.
    /// Custom-grant only: no built-in role fallback.
    LogisticsPod,
    /// Derive the SLA assessment and operational-cost settlement after delivery.
    /// Custom-grant only: no built-in role fallback.
    LogisticsSettle,
    /// Read IV inventory stock objects/events inside the caller's branch scope.
    InventoryRead,
    /// Create/update/archive IV inventory items, locations, and thresholds.
    InventoryManage,
    /// Consume IV inventory stock against visible work orders or P1 dispatches.
    InventoryConsume,
    /// Prepare future reorder/purchase requests from low-stock IV items.
    InventoryReorder,
    /// Read tenant benefit-catalog policy rows and console-ready legal/extra benefit details.
    BenefitCatalogRead,
    /// Create and maintain tenant benefit-catalog rows, tiers, and conditions.
    BenefitCatalogManage,
    /// Dedicated consulting pilot read gate. Kept distinct from benefit policy
    /// management so rollout may remain dark without borrowing authority.
    ConsultingRead,
    /// Dedicated consulting pilot mutation gate.
    ConsultingManage,
    /// Read the tenant compliance domain (regulations, obligations, frameworks,
    /// and controls). Org-wide catalog rows require an org-wide principal;
    /// branch-scoped obligations are separately authorized at their branch.
    ComplianceDomainRead,
    /// Create tenant compliance-domain rows and append compliance relations.
    /// Org-wide resources require org-wide authorization.
    ComplianceDomainManage,
    /// Link evidence to a compliance control or obligation. This is separate
    /// from generic work-report evidence attachment because it changes the
    /// audited compliance evidence register.
    ComplianceEvidenceLink,
    /// Permission metadata for the future AI assistant seam. T0.6 requires the
    /// 22-feature matrix; this does not implement an AI adapter or demo mode.
    AiAssist,
    /// Read governance findings from the integrity engine.
    /// EXECUTIVE + SUPER_ADMIN only — labor-law sensitivity; an ADMIN must NOT
    /// read findings about themselves or their subordinates.
    IntegrityFindingsRead,
    /// Triage (OPEN → REVIEWED / DISMISSED / ESCALATED) a governance finding.
    /// Gated identically to read; triage is itself audited via `with_audit`.
    IntegrityFindingTriage,
    /// Configure the tenant's corporate webmail account (SMTP/IMAP host, port,
    /// credentials). Stores credentials write-only (envelope AEAD); every change
    /// is audited. ADMIN + SUPER_ADMIN only — it holds the mailbox secrets.
    MailAccountManage,
    /// Use the configured webmail: send / reply / forward, and (in later
    /// batches) read inbound threads. RECEPTIONIST + ADMIN + EXECUTIVE +
    /// SUPER_ADMIN; MECHANIC is excluded (work lives in the messenger surface).
    MailUse,
    /// Read the tenant HR employee directory. EXECUTIVE + ADMIN + SUPER_ADMIN only.
    EmployeeDirectoryRead,
    /// Import/manage tenant HR employee rows. ADMIN + SUPER_ADMIN only; employees
    /// are deliberately not auth users.
    EmployeeDirectoryManage,
    /// Report a staff exit case (무단결근 → 퇴사 보고). The branch/site manager
    /// tier — ADMIN + SUPER_ADMIN. Distinct from HR/HQ confirmation so a site
    /// manager can open a case without holding the confirmation authority.
    ExitCaseReport,
    /// First-tier (HR) confirmation of a reported exit case. ADMIN + SUPER_ADMIN.
    /// Separation of duties: the code additionally requires the HQ confirmer to
    /// differ from the recorded HR confirmer, so holding this capability is
    /// necessary but not sufficient to also HQ-confirm the same case.
    ExitCaseHrConfirm,
    /// Second-tier (HQ) confirmation of an already HR-confirmed exit case.
    /// EXECUTIVE + SUPER_ADMIN — the headquarters/leadership tier, mirroring the
    /// org-wide tier of [`OrgWideQueueTriage`]. The client `hq_confirmation`
    /// boolean is NOT the authority: this capability plus a prior HR_CONFIRMED by
    /// a DIFFERENT actor is.
    ExitCaseHqConfirm,
    /// Generate/draft the exit settlement package + submit it for approval
    /// (퇴직 정산 초안/승인 상신). ADMIN + SUPER_ADMIN — the HR settlement tier.
    ExitSettlementManage,
    /// Manage attendance exceptions. ADMIN + SUPER_ADMIN only; the Attendance
    /// REST boundary continues to enforce branch/resource scope independently.
    AttendanceExceptionManage,
    /// Manage attendance substitutions. ADMIN + SUPER_ADMIN only; the
    /// Attendance REST boundary continues to enforce branch/resource scope independently.
    AttendanceSubstitutionManage,
    /// Read the CEO/top-clearance covert audit stream. This is deliberately
    /// denied by the legacy role matrix and enrolled only through Cedar/PBAC
    /// clearance facts.
    AuditStreamRead,
    /// Read the audit-of-access stream for CEO/top-clearance audit reads.
    /// Deliberately Cedar-only like [`Self::AuditStreamRead`].
    AuditStreamAccessLogRead,
    /// Lock/unlock payroll & accounting freeze windows (월마감/마감). Locking a
    /// period makes every date-stamping write inside it fail closed, so this is
    /// the close authority: ADMIN + EXECUTIVE + SUPER_ADMIN.
    PeriodLockManage,
    /// Drive the generic object-lifecycle engine (state transitions, legal
    /// hold, retention). ADMIN + SUPER_ADMIN — the records-management tier,
    /// mirroring how payroll admin endpoints gate.
    LifecycleManage,
    /// Read payroll draft-run/line staging rows (`payroll_draft_runs`/
    /// `payroll_draft_lines`, mig 0074). Financial/HR-sensitive; gated via
    /// `authorize_org_wide` because the table has no `branch_id` column to
    /// narrow a branch-scoped ADMIN's visibility. Built-in access is
    /// EXECUTIVE + SUPER_ADMIN only — `authorize_org_wide`'s built-in path
    /// never grants ADMIN (all-branch-scoped or not), matching
    /// `EmployeeDirectoryRead`/`OrgWideQueueTriage` today; an ADMIN's only
    /// path in is a custom org-wide PBAC grant. See the payroll REST crate's
    /// module docs for the deny-by-omission rationale.
    PayrollRunRead,
    /// Drive the payroll run lifecycle (attendance close, calculation,
    /// exception resolution, submit/decide/withdraw, disbursement
    /// scheduling/attestation, payslip issuance). Same matrix row and
    /// org-wide gating as [`Self::PayrollRunRead`]: gated via
    /// `authorize_org_wide` (the tables have `org_id` only), built-in access
    /// EXECUTIVE + SUPER_ADMIN, ADMIN only via a custom org-wide PBAC grant,
    /// branch-scoped callers denied.
    PayrollRunManage,
    /// Create a draft board notice, publish it (issues the NT- code, snapshots
    /// every active org member as a recipient, and fans out a notification to
    /// each), and read 수령확인 progress. The HQ/announcement tier: ADMIN +
    /// EXECUTIVE + SUPER_ADMIN. Reading a PUBLISHED notice is open to any
    /// authenticated org member — this feature gates only draft visibility and
    /// the publish/progress mutations.
    NoticeManage,
    /// Operate the scheduled HVAC preventive-maintenance queue.
    FacilitiesManage,
    /// Triage and assign scheduled facilities cases.
    FacilitiesDispatch,
    /// Start and submit assigned facilities work.
    FacilitiesExecute,
    /// Accept or reject submitted facilities work.
    FacilitiesAccept,
    /// Read facilities cases and record metering observations.
    FacilitiesObserve,
    /// Dedicated workload-only production source ingress. Built-in human roles
    /// are all denied; a registered service principal receives this only via an
    /// explicit tenant-scoped effective grant.
    ProductionSourceIngest,
    /// Register serialized 3R rental units. Custom-grant only: no built-in
    /// role fallback.
    Equipment3rRegistry,
    /// Create idempotent 3R rental-case quotes. Custom-grant only: no built-in
    /// role fallback.
    Equipment3rQuote,
    /// Approve or decline a quoted 3R rental case (four-eyes enforced).
    /// Custom-grant only: no built-in role fallback.
    Equipment3rApprove,
    /// Dispatch an approved 3R case and record customer handover. Custom-grant
    /// only: no built-in role fallback.
    Equipment3rDispatch,
    /// Record on-rent 3R inspections and maintenance. Custom-grant only: no
    /// built-in role fallback.
    Equipment3rInspect,
    /// Record 3R returns and return assessments. Custom-grant only: no
    /// built-in role fallback.
    Equipment3rAssess,
    /// Complete repair/refurbish/resale dispositions. Custom-grant only: no
    /// built-in role fallback.
    Equipment3rDisposition,
    /// Read 3R units, rental cases, and history. Custom-grant only: no
    /// built-in role fallback.
    Equipment3rObserve,
    /// Read the recruiting pipeline (postings, applicants, offers, talent
    /// pool). HR-owned data: ADMIN + EXECUTIVE + SUPER_ADMIN, mirroring
    /// `EmployeeDirectoryRead`. Gated org-wide (`authorize_org_wide`) — the
    /// recruiting tables carry no branch column to narrow by.
    RecruitingRead,
    /// Manage the recruiting pipeline: postings (draft/publish/close),
    /// applicant transitions, offers, and the hire handshake. ADMIN +
    /// SUPER_ADMIN, mirroring `EmployeeDirectoryManage`; hire additionally
    /// requires `EmployeeDirectoryManage` (the owning HR domain's gate).
    RecruitingManage,
    /// Read evaluation cycles, subjects, preflight reports, and the finalized
    /// person ledger. HR-sensitive — mirrors the `EmployeeDirectoryRead` tier
    /// (ADMIN + EXECUTIVE + SUPER_ADMIN); the person-ledger read is itself
    /// audited (`evaluation.history.viewed`).
    EvaluationRead,
    /// Drive the evaluation cycle lifecycle (create/open/start-calibration/
    /// finalize/archive), enroll subjects, replace goals, and calibrate.
    /// Mirrors the `EmployeeDirectoryManage` tier (ADMIN + SUPER_ADMIN); the
    /// calibration handler additionally enforces four-eyes SoD in code.
    EvaluationManage,
    /// Record and submit self/manager review drafts and read one's own
    /// evaluation task list. The per-subject check (caller is the subject's
    /// assigned manager, or holds `EvaluationManage`) is enforced in code with
    /// deny-by-omission 404s.
    EvaluationSubmit,
    /// Read org-change requests, the org-entity picker and the OrgUnit tree
    /// (`/api/v1/org-changes`, `/api/v1/org-units` GET). ADMIN + EXECUTIVE +
    /// SUPER_ADMIN (catalog key registered by 0198).
    OrgChangeRead,
    /// Draft/edit/submit org changes, including the OrgUnit and legacy
    /// region/branch convenience drafts. Same tier as [`Self::OrgChangeRead`].
    OrgChangeDraft,
    /// Decide org-change approval steps. EXECUTIVE + SUPER_ADMIN.
    OrgChangeApprove,
    /// Effectuate/schedule/cancel an approved org change. EXECUTIVE + SUPER_ADMIN.
    OrgChangeApply,
    // PREREG-2 (concurrency plan §3, challenge C6): the eight features whose
    // `feature_catalog` rows landed in 0248. Cedar-only like GOV-CED-1: the
    // legacy matrix grants nobody, custom roles cannot grant them, and each
    // endpoint denies until its per-action Cedar schema is enrolled.
    /// Change a tenant settings override (BW-00; governance S1, S2).
    SettingsManage,
    /// Add or retire tenant reason codes in an extensible domain (BW-07; S3).
    ReasonCodeManage,
    /// Decide a governed exception as the second person (BW-06; S5).
    ExceptionDecide,
    /// File a privacy request about oneself (Cedar-only).
    PrivacyRequestFile,
    /// Intake and decide privacy requests in the subject scope (Cedar-only).
    PrivacyRequestDecide,
    /// Change approval routes, approver groups and delegation rules (BW-01; S4).
    ApprovalRouteManage,
    /// Decide a change request filed by someone else (BW-17; S10).
    ChangeRequestDecide,
    /// Manage the tenant job-title list (BW-13).
    JobTitleManage,
    /// Read records retained after tenant offboarding (BW-36; deferred, OD-7: inert).
    RetainedRecordsRead,
    /// Start tenant offboarding (BW-36; deferred, OD-7: inert).
    TenantOffboard,
    /// Register and revise 법인 · 사업자등록 · 사업장 (decisions #14.2), apart from
    /// the org-change grants. Cedar-only: its per-action schema decides.
    LegalEntityManage,
    /// Erase a never-used 부서, and 폐지 or set 부서장 · 부서 코드 directly after go-live
    /// (decisions #21, #26; CRUD). Cedar-only (`actions/org_unit_manage.rs`).
    OrgUnitManage,
}

impl Feature {
    pub const ALL: [Self; 112] = [
        Self::Login,
        Self::WorkOrderCreate,
        Self::WorkOrderEditIntake,
        Self::WorkOrderReadAll,
        Self::WorkOrderStart,
        Self::WorkReportSubmit,
        Self::EvidenceAttach,
        Self::PriorityManage,
        Self::AssigneeManage,
        Self::TargetManage,
        Self::CompletionReview,
        Self::ApprovalFinalize,
        Self::DailyPlanRequest,
        Self::DailyPlanReview,
        Self::OrgWideQueueTriage,
        Self::KpiRead,
        Self::KpiExclusionManage,
        Self::UserManage,
        Self::SubordinateUserCreate,
        Self::ElevatedRoleGrant,
        Self::RoleManage,
        Self::RegionManage,
        Self::BranchManage,
        Self::EquipmentManage,
        Self::MasterListImport,
        Self::RentalQuoteManage,
        Self::EquipmentCostLedgerRead,
        Self::EquipmentCostLedgerWrite,
        Self::PurchaseRequestCreate,
        Self::PurchaseRequestRead,
        Self::PurchaseRequestApprove,
        Self::PurchaseFinalApprove,
        Self::PurchaseExecute,
        Self::InspectionScheduleManage,
        Self::InspectionRoundComplete,
        Self::AuditLogRead,
        Self::ExcelDownload,
        Self::OpsDashboardRead,
        Self::SalesManage,
        Self::LogisticsReceive,
        Self::LogisticsPutaway,
        Self::LogisticsRelease,
        Self::LogisticsPickPack,
        Self::LogisticsDispatch,
        Self::LogisticsPod,
        Self::LogisticsSettle,
        Self::InventoryRead,
        Self::InventoryManage,
        Self::InventoryConsume,
        Self::InventoryReorder,
        Self::BenefitCatalogRead,
        Self::BenefitCatalogManage,
        Self::ConsultingRead,
        Self::ConsultingManage,
        Self::ComplianceDomainRead,
        Self::ComplianceDomainManage,
        Self::ComplianceEvidenceLink,
        Self::AiAssist,
        Self::IntegrityFindingsRead,
        Self::IntegrityFindingTriage,
        Self::MailAccountManage,
        Self::MailUse,
        Self::EmployeeDirectoryRead,
        Self::EmployeeDirectoryManage,
        Self::ExitCaseReport,
        Self::ExitCaseHrConfirm,
        Self::ExitCaseHqConfirm,
        Self::ExitSettlementManage,
        Self::AttendanceExceptionManage,
        Self::AttendanceSubstitutionManage,
        Self::AuditStreamRead,
        Self::AuditStreamAccessLogRead,
        Self::PeriodLockManage,
        Self::LifecycleManage,
        Self::PayrollRunRead,
        Self::PayrollRunManage,
        Self::NoticeManage,
        Self::FacilitiesManage,
        Self::FacilitiesDispatch,
        Self::FacilitiesExecute,
        Self::FacilitiesAccept,
        Self::FacilitiesObserve,
        Self::ProductionSourceIngest,
        Self::Equipment3rRegistry,
        Self::Equipment3rQuote,
        Self::Equipment3rApprove,
        Self::Equipment3rDispatch,
        Self::Equipment3rInspect,
        Self::Equipment3rAssess,
        Self::Equipment3rDisposition,
        Self::Equipment3rObserve,
        Self::RecruitingRead,
        Self::RecruitingManage,
        Self::EvaluationRead,
        Self::EvaluationManage,
        Self::EvaluationSubmit,
        Self::OrgChangeRead,
        Self::OrgChangeDraft,
        Self::OrgChangeApprove,
        Self::OrgChangeApply,
        Self::SettingsManage,
        Self::ReasonCodeManage,
        Self::ExceptionDecide,
        Self::PrivacyRequestFile,
        Self::PrivacyRequestDecide,
        Self::ApprovalRouteManage,
        Self::ChangeRequestDecide,
        Self::JobTitleManage,
        Self::RetainedRecordsRead,
        Self::TenantOffboard,
        Self::LegalEntityManage,
        Self::OrgUnitManage,
    ];
}
