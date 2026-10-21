use super::Feature;
use crate::PermissionLevel;

impl Feature {
    pub(crate) const fn matrix_row(self) -> [PermissionLevel; 6] {
        use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

        // Column order matches `Role::matrix_index`:
        // [MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE, SUPER_ADMIN].
        // MEMBER (the open-signup default) is default-DENY everywhere except
        // `Login`: a self-registered account can authenticate but sees nothing
        // actionable until an admin grants it a real role.
        match self {
            Self::Login => [A, A, A, A, A, A],
            Self::WorkOrderCreate => [D, A, L, A, L, A],
            Self::WorkOrderEditIntake => [D, A, L, A, L, A],
            Self::WorkOrderReadAll => [D, A, A, A, A, A],
            Self::WorkOrderStart => [D, L, A, A, L, A],
            Self::WorkReportSubmit => [D, L, A, A, L, A],
            Self::EvidenceAttach => [D, A, A, A, L, A],
            Self::PriorityManage => [D, D, D, A, D, A],
            Self::AssigneeManage => [D, D, D, A, D, A],
            Self::TargetManage => [D, D, R, A, D, A],
            Self::CompletionReview => [D, D, D, A, D, A],
            Self::ApprovalFinalize => [D, D, D, A, A, A],
            Self::DailyPlanRequest => [D, D, A, A, D, A],
            Self::DailyPlanReview => [D, D, D, A, D, A],
            // Org-wide queue read: EXECUTIVE + SUPER_ADMIN only, matching the
            // org-wide tier of `resolve_branch_scope_in_org`. A branch ADMIN is
            // deliberately NOT here — it stays confined to its branch scope.
            Self::OrgWideQueueTriage => [D, D, D, D, A, A],
            Self::KpiRead => [D, D, D, A, A, A],
            Self::KpiExclusionManage => [D, D, D, A, A, A],
            Self::UserManage => [D, D, D, A, D, A],
            Self::SubordinateUserCreate => [D, D, D, L, D, A],
            Self::ElevatedRoleGrant => [D, D, D, D, D, A],
            Self::RoleManage => [D, D, D, D, D, A],
            Self::RegionManage => [D, D, D, A, A, A],
            Self::BranchManage => [D, D, D, A, A, A],
            Self::EquipmentManage => [D, D, D, A, A, A],
            Self::MasterListImport => [D, D, D, A, D, A],
            Self::RentalQuoteManage => [D, A, D, A, A, A],
            Self::EquipmentCostLedgerRead => [D, D, D, A, A, A],
            Self::EquipmentCostLedgerWrite => [D, D, D, A, D, A],
            Self::PurchaseRequestCreate => [D, A, R, A, D, A],
            Self::PurchaseRequestRead => [D, A, L, A, A, A],
            Self::PurchaseRequestApprove => [D, D, D, A, D, A],
            Self::PurchaseFinalApprove => [D, D, D, D, A, A],
            Self::PurchaseExecute => [D, A, D, A, D, A],
            Self::InspectionScheduleManage => [D, D, D, A, D, A],
            Self::InspectionRoundComplete => [D, D, A, A, D, A],
            Self::AuditLogRead => [D, D, D, A, D, A],
            Self::ExcelDownload => [D, A, A, A, A, A],
            Self::OpsDashboardRead => [D, D, D, A, D, A],
            Self::SalesManage => [D, D, D, A, A, A],
            // Logistics is capability-driven from its first slice. Built-in
            // roles do not silently widen access; explicit tenant grants are
            // the only allow path.
            Self::LogisticsReceive
            | Self::LogisticsPutaway
            | Self::LogisticsRelease
            | Self::LogisticsPickPack
            | Self::LogisticsDispatch
            | Self::LogisticsPod
            | Self::LogisticsSettle => [D, D, D, D, D, D],
            // IV inventory is branch-operational: front-office/mechanics may
            // read stock; mechanics/admins may consume; management/reorder
            // remains the admin tier until purchase integration lands.
            Self::InventoryRead => [D, A, A, A, A, A],
            Self::InventoryManage => [D, D, D, A, D, A],
            Self::InventoryConsume => [D, D, A, A, D, A],
            Self::InventoryReorder => [D, D, D, A, D, A],
            // Benefits are HR/legal policy data. Admin/super-admin can manage;
            // executives can read org-wide catalog state for policy oversight.
            Self::BenefitCatalogRead => [D, D, D, A, A, A],
            Self::BenefitCatalogManage => [D, D, D, A, D, A],
            // Deliberately deny every built-in role while the console is dark.
            Self::ConsultingRead => [D, D, D, D, D, D],
            Self::ConsultingManage => [D, D, D, D, D, D],
            // Compliance's org-owned catalog objects are additionally guarded
            // by the REST boundary's org-wide scope check. The ADMIN cells keep
            // branch-scoped obligation work available without granting an
            // arbitrary branch an org-wide regulation/framework/evidence view.
            Self::ComplianceDomainRead => [D, D, D, A, A, A],
            Self::ComplianceDomainManage => [D, D, D, A, D, A],
            Self::ComplianceEvidenceLink => [D, D, D, A, D, A],
            // Retain the historical wire key without granting an AI capability in v1.
            Self::AiAssist => [D, D, D, D, D, D],
            // Integrity findings are labor-law sensitive: ADMIN must not read
            // findings about themselves. EXECUTIVE + SUPER_ADMIN only.
            Self::IntegrityFindingsRead => [D, D, D, D, A, A],
            Self::IntegrityFindingTriage => [D, D, D, D, A, A],
            // Configuring the mailbox holds the tenant's mail secrets: ADMIN +
            // SUPER_ADMIN only.
            Self::MailAccountManage => [D, D, D, A, D, A],
            // Sending/replying/forwarding mail: front-office + leadership.
            // MECHANIC is excluded (their workflow is the messenger surface).
            Self::MailUse => [D, A, D, A, A, A],
            Self::EmployeeDirectoryRead => [D, D, D, A, A, A],
            Self::EmployeeDirectoryManage => [D, D, D, A, D, A],
            // Separation of duties across the absence → exit → settlement chain.
            // Report + HR confirm + settlement are the branch HR/manager tier
            // (ADMIN + SUPER_ADMIN); HQ confirm is the org-wide leadership tier
            // (EXECUTIVE + SUPER_ADMIN), matching OrgWideQueueTriage. A single
            // SUPER_ADMIN could hold both confirm cells, but the confirm handler's
            // distinct-actor check still forbids one person from doing both tiers
            // on the same case.
            Self::ExitCaseReport => [D, D, D, A, D, A],
            Self::ExitCaseHrConfirm => [D, D, D, A, D, A],
            Self::ExitCaseHqConfirm => [D, D, D, D, A, A],
            Self::ExitSettlementManage => [D, D, D, A, D, A],
            Self::AttendanceExceptionManage | Self::AttendanceSubstitutionManage => {
                [D, D, D, A, D, A]
            }
            // B26b covert audit stream: no legacy/static-role fallback. Cedar
            // clearance facts are the only allow path; omission denies.
            Self::AuditStreamRead | Self::AuditStreamAccessLogRead => [D, D, D, D, D, D],
            // Freezing a payroll/accounting period is close authority: the
            // branch close tier (ADMIN) plus org-wide leadership (EXECUTIVE),
            // and SUPER_ADMIN.
            Self::PeriodLockManage => [D, D, D, A, A, A],
            Self::LifecycleManage => [D, D, D, A, D, A],
            // Payroll draft-run/line staging read: financial/HR-sensitive,
            // same tier as EmployeeDirectoryRead. Gated via
            // `authorize_org_wide` (requires BranchScope::All) since the
            // table has no branch_id to narrow a branch-scoped ADMIN.
            Self::PayrollRunRead => [D, D, D, A, A, A],
            // Payroll run lifecycle writes: identical row + org-wide gating to
            // PayrollRunRead (ADMIN cell only ever reachable through a custom
            // org-wide PBAC grant — `authorize_org_wide`'s built-in path never
            // grants ADMIN).
            Self::PayrollRunManage => [D, D, D, A, A, A],
            // The HQ/announcement tier: ADMIN + EXECUTIVE + SUPER_ADMIN.
            Self::NoticeManage => [D, D, D, A, A, A],
            Self::FacilitiesManage => [D, D, D, A, D, A],
            Self::FacilitiesDispatch => [D, D, D, A, D, A],
            Self::FacilitiesExecute => [D, D, A, A, D, A],
            Self::FacilitiesAccept => [D, D, D, A, D, A],
            Self::FacilitiesObserve => [D, A, A, A, A, A],
            Self::ProductionSourceIngest => [D, D, D, D, D, D],
            // Equipment 3R is capability-driven from its first slice. Built-in
            // roles do not silently widen access; explicit tenant grants are
            // the only allow path.
            Self::Equipment3rRegistry
            | Self::Equipment3rQuote
            | Self::Equipment3rApprove
            | Self::Equipment3rDispatch
            | Self::Equipment3rInspect
            | Self::Equipment3rAssess
            | Self::Equipment3rDisposition
            | Self::Equipment3rObserve => [D, D, D, D, D, D],
            // Recruiting mirrors the HR directory pair: recruiting rows are
            // HR-owned data with EXECUTIVE read-only visibility.
            Self::RecruitingRead => [D, D, D, A, A, A],
            Self::RecruitingManage => [D, D, D, A, D, A],
            // Evaluation is HR-sensitive: read/submit mirror the
            // EmployeeDirectoryRead tier, manage mirrors EmployeeDirectoryManage.
            // The per-subject submit check and calibration four-eyes SoD are
            // additionally enforced in the evaluation REST/adapter code.
            Self::EvaluationRead => [D, D, D, A, A, A],
            Self::EvaluationManage => [D, D, D, A, D, A],
            Self::EvaluationSubmit => [D, D, D, A, A, A],
            // Org changes: the byte-for-byte floors orgchange-rest enforced as
            // role lists before these variants existed.
            Self::OrgChangeRead | Self::OrgChangeDraft => [D, D, D, A, A, A],
            Self::OrgChangeApprove | Self::OrgChangeApply => [D, D, D, D, A, A],
            // PREREG-2: Cedar-only. No legacy decision exists, so the matrix
            // grants nobody; the per-action Cedar schema is the only allow path.
            Self::SettingsManage
            | Self::ReasonCodeManage
            | Self::ExceptionDecide
            | Self::ApprovalRouteManage
            | Self::ChangeRequestDecide
            | Self::JobTitleManage
            | Self::RetainedRecordsRead
            | Self::TenantOffboard
            // decisions #14.2: entity administration decides in Cedar
            // (`actions/legal_entity_manage.rs`), never in the legacy matrix.
            | Self::LegalEntityManage
            // CRUD: direct 부서 erase / 폐지 / 부서장 · 코드 (`actions/org_unit_manage.rs`).
            | Self::OrgUnitManage => [D, D, D, D, D, D],
        }
    }
}
