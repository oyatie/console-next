//! AX-2: the tag of every operation key ([`Feature`]) with exactly one
//! (domain, level). An untagged key is fenced: no role line can reach it
//! (GR-11). The match in [`tag`] is exhaustive on purpose — a new `Feature`
//! does not compile until someone decides its domain or fences it.

use super::catalog::{Domain, Level};
use crate::Feature;

/// The (domain, level) an operation key belongs to, or `None` when it is fenced
/// (asset/maintenance and every other non-MVP module, AI, mail, the ops-only
/// `tenant_offboard`, and `login`, which is a self action).
#[must_use]
pub const fn tag(feature: Feature) -> Option<(Domain, Level)> {
    use Domain as D;
    use Feature as F;
    use Level as L;
    match feature {
        F::OrgChangeRead => Some((D::Org, L::View)),
        F::OrgChangeDraft
        | F::OrgChangeApply
        | F::JobTitleManage
        | F::LegalEntityManage
        | F::OrgUnitManage => Some((D::Org, L::Edit)),
        F::OrgChangeApprove => Some((D::Org, L::Approve)),
        F::EmployeeDirectoryRead => Some((D::HrBasic, L::View)),
        F::EmployeeDirectoryManage | F::MasterListImport => Some((D::HrBasic, L::Edit)),
        // governance-04: the 명부 download is the 인사기본 내보내기 level.
        F::ExcelDownload => Some((D::HrBasic, L::Export)),
        F::LifecycleManage => Some((D::Appointment, L::Edit)),
        // The HR confirmation IS the exit (it records the TERMINATE), not a 결재:
        // 퇴직 등록·수정 does it (#26: no approval on the pilot path). Only the
        // routed HQ tier is a 결재.
        F::ExitCaseReport | F::ExitSettlementManage | F::ExitCaseHrConfirm => {
            Some((D::Exit, L::Edit))
        }
        F::ExitCaseHqConfirm => Some((D::Exit, L::Approve)),
        F::AttendanceExceptionManage | F::AttendanceSubstitutionManage => {
            Some((D::Attendance, L::Edit))
        }
        F::PayrollRunRead => Some((D::Pay, L::View)),
        F::PayrollRunManage => Some((D::Pay, L::Edit)),
        F::EvaluationRead => Some((D::Evaluation, L::View)),
        F::EvaluationManage => Some((D::Evaluation, L::Edit)),
        F::EvaluationSubmit => Some((D::Evaluation, L::Approve)),
        F::NoticeManage => Some((D::Notice, L::Edit)),
        F::UserManage | F::SubordinateUserCreate | F::ElevatedRoleGrant | F::RoleManage => {
            Some((D::Access, L::Edit))
        }
        F::AuditLogRead | F::AuditStreamRead | F::AuditStreamAccessLogRead => {
            Some((D::Audit, L::View))
        }
        F::SettingsManage | F::ReasonCodeManage | F::ApprovalRouteManage => {
            Some((D::Settings, L::Edit))
        }
        F::PeriodLockManage => Some((D::Exceptions, L::Edit)),
        F::ExceptionDecide | F::ChangeRequestDecide => Some((D::Exceptions, L::Approve)),
        F::RetainedRecordsRead => Some((D::Retention, L::View)),
        F::Login
        | F::TenantOffboard
        | F::WorkOrderCreate
        | F::WorkOrderEditIntake
        | F::WorkOrderReadAll
        | F::WorkOrderStart
        | F::WorkReportSubmit
        | F::EvidenceAttach
        | F::PriorityManage
        | F::AssigneeManage
        | F::TargetManage
        | F::CompletionReview
        | F::ApprovalFinalize
        | F::DailyPlanRequest
        | F::DailyPlanReview
        | F::OrgWideQueueTriage
        | F::KpiRead
        | F::KpiExclusionManage
        | F::RegionManage
        | F::BranchManage
        | F::EquipmentManage
        | F::RentalQuoteManage
        | F::EquipmentCostLedgerRead
        | F::EquipmentCostLedgerWrite
        | F::PurchaseRequestCreate
        | F::PurchaseRequestRead
        | F::PurchaseRequestApprove
        | F::PurchaseFinalApprove
        | F::PurchaseExecute
        | F::InspectionScheduleManage
        | F::InspectionRoundComplete
        | F::OpsDashboardRead
        | F::SalesManage
        | F::LogisticsReceive
        | F::LogisticsPutaway
        | F::LogisticsRelease
        | F::LogisticsPickPack
        | F::LogisticsDispatch
        | F::LogisticsPod
        | F::LogisticsSettle
        | F::InventoryRead
        | F::InventoryManage
        | F::InventoryConsume
        | F::InventoryReorder
        | F::BenefitCatalogRead
        | F::BenefitCatalogManage
        | F::ConsultingRead
        | F::ConsultingManage
        | F::ComplianceDomainRead
        | F::ComplianceDomainManage
        | F::ComplianceEvidenceLink
        | F::AiAssist
        | F::IntegrityFindingsRead
        | F::IntegrityFindingTriage
        | F::MailAccountManage
        | F::MailUse
        | F::FacilitiesManage
        | F::FacilitiesDispatch
        | F::FacilitiesExecute
        | F::FacilitiesAccept
        | F::FacilitiesObserve
        | F::ProductionSourceIngest
        | F::Equipment3rRegistry
        | F::Equipment3rQuote
        | F::Equipment3rApprove
        | F::Equipment3rDispatch
        | F::Equipment3rInspect
        | F::Equipment3rAssess
        | F::Equipment3rDisposition
        | F::Equipment3rObserve
        | F::RecruitingRead
        | F::RecruitingManage => None,
    }
}

/// Every tagged operation key with its (domain, level), in `Feature::ALL` order.
pub fn tagged() -> impl Iterator<Item = (Feature, Domain, Level)> {
    Feature::ALL
        .into_iter()
        .filter_map(|f| tag(f).map(|(d, l)| (f, d, l)))
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
