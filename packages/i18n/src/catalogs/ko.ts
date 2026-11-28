import { koShellRoutes } from "./ko/shell-routes";
import { koAccessCheck } from "./ko/access-check";
import { koAuth } from "./ko/auth";
import { koAccessPolicies } from "./ko/access-policies";
import { koUiFlexibleColumns } from "./ko/ui-flexible-columns";
import { koGovernanceRefusals } from "./ko/governance";
import { koDirectoryViews } from "./ko/directory-views";
import { koAccountLinkRefusals } from "./ko/account_link";
import { koPeriodUnlockRefusals } from "./ko/period_unlock";
import { koPrivacyRefusals } from "./ko/privacy";
import { koLeave } from "./ko/leave";
import { koOrgChangeRefusals } from "./ko/org_change";
import { koPayroll } from "./ko/payroll";
import { koPayrollOutlook } from "./ko/payroll-outlook";
import { koPayrollRun } from "./ko/payroll-run";
import { koPayslip } from "./ko/payslip";
import { koUiShiftBar } from "./ko/ui-shift-bar";
import { koNts } from "./ko/nts";
import { koSupport } from "./ko/support";
import { koSupportAccess } from "./ko/support-access";
import { koCommon } from "./ko/common";
import { koOpsRecovery } from "./ko/ops-recovery";
import { koImportRollback } from "./ko/import-rollback";
import { koComposer } from "./ko/composer";
import { koStatutory } from "./ko/statutory";
import { koRequestOutcome } from "./ko/request-outcome";
// Korean for every screen id that en.ts defines; a missing id fails typecheck. Rules: en.ts.
import type { ScreenMessageId } from "./en";
import { koFormat } from "./ko/format";
import { koAsof } from "./ko/asof";
import { koTimeline } from "./ko/timeline";
import { koHome } from "./ko/home";
import { koApprovals } from "./ko/approvals";
import { koOrg } from "./ko/org";
import { koPeople } from "./ko/people";
import { koExit } from "./ko/exit";
import { koAccounts } from "./ko/accounts";
import { koAccess } from "./ko/access";
import { koAccessReview } from "./ko/access-review";
import { koAccessLog } from "./ko/access-log";
import { koInternalCalendar } from "./ko/internal-calendar";
import { koBenefits } from "./ko/benefits";
import { koAudit } from "./ko/audit";
import { koAccessCodes } from "./ko/access-codes";
import { koDenied } from "./ko/denied";
import { koAccessGrants } from "./ko/access-grants";
import { koAccount } from "./ko/account";
import { koPeriodLocks } from "./ko/period-locks";
import { koAttendance } from "./ko/attendance";
import { koAttendanceRefusals } from "./ko/attendance.refuse";
import { koAttendanceSchedule } from "./ko/attendance-schedule";
import { koAttendancePatterns } from "./ko/attendance-patterns";
import { koAttendanceHolidays } from "./ko/attendance-holidays";
import { koAttendanceCrews } from "./ko/attendance-crews";
import { koAttendanceOverview } from "./ko/attendance-overview";
import { koAttendanceRecords } from "./ko/attendance-records";
import { koConsulting } from "./ko/consulting";
import { koEvaluation } from "./ko/evaluation";
import { koMe } from "./ko/me";
import { koTeam } from "./ko/team";
import { koImport } from "./ko/import";
import { koImportSheet } from "./ko/import-sheet";
import { koImportReview } from "./ko/import-review";
import { koNotice } from "./ko/notice";
import { koRenew } from "./ko/renew";
import { koImportChanges } from "./ko/import-changes";
import { koImportValues } from "./ko/import-values";
import { koImportJob } from "./ko/import-job";
import { koImportReconcile } from "./ko/import-reconcile";
import { koIdentifiers } from "./ko/identifiers";
import { koTenants } from "./ko/tenants";
import { koEnum } from "./ko/enum";
import { koLive } from "./ko/live";
import { koUiField } from "./ko/ui-field";
import { koUiReason } from "./ko/ui-reason";
import { koUiChoice } from "./ko/ui-choice";
import { koUiDate } from "./ko/ui-date";
import { koUiBlocker } from "./ko/ui-blocker";
import { koUiConflict } from "./ko/ui-conflict";
import { koUiReceipt } from "./ko/ui-receipt";
import { koUiDeadlineChip } from "./ko/ui-deadline-chip";
import { koUiChainStepper } from "./ko/ui-chain-stepper";
import { koUiApprovalCard } from "./ko/ui-approval-card";
import { koUiRecordVerbs } from "./ko/ui-record-verbs";
import { koUiRecordActions } from "./ko/ui-record-actions";
import { koEmpContact } from "./ko/emp-contact";
import { koEmpPhoto } from "./ko/emp-photo";
import { koUiOverrideSheet } from "./ko/ui-override-sheet";
import { koUiHandoff } from "./ko/ui-handoff";
import { koUiLongTable } from "./ko/ui-long-table";
import { koUiServerPicker } from "./ko/ui-server-picker";
import { koUiSetupRail } from "./ko/ui-setup-rail";
import { koUiStepLine } from "./ko/ui-step-line";
import { koUiSectionConfirm } from "./ko/ui-section-confirm";
import { koUiFileDrop } from "./ko/ui-file-drop";
import { koUiCodePicker } from "./ko/ui-code-picker";
import { koUiAddressField } from "./ko/ui-address-field";
import { koUiSheet } from "./ko/ui-sheet";
import { koUiCrumbs } from "./ko/ui-crumbs";
import { koRoster } from "./ko/roster";
import { koPerson } from "./ko/person";
import { koFacts } from "./ko/facts";
import { koGroupTransfer } from "./ko/group-transfer";
import { koLifecycle } from "./ko/lifecycle";
import { koBulk } from "./ko/bulk";
import { koOrgTree } from "./ko/org-tree";
import { koOrgPropose } from "./ko/org-propose";
import { koOrgChange } from "./ko/org-change";
import { koUiTimelineLanes } from "./ko/ui-timeline-lanes";
import { koEntity } from "./ko/entity";
import { koWorkplace } from "./ko/workplace";
import { koWorkplaceRegChange } from "./ko/workplace-reg-change";
import { koCapture } from "./ko/capture";
import { koEntityCreate } from "./ko/entity-create";
import { koEntityHistoryField } from "./ko/entity-history-field";
import { koEntityQuick } from "./ko/entity-quick";
import { koEntityRecord } from "./ko/entity-record";
import { koEntityRecordClose } from "./ko/entity-record-close";
import { koEntityOps } from "./ko/entity-ops";
import { koEntityReissue } from "./ko/entity-reissue";
import { koOrgStructure } from "./ko/org-structure";
import { koOrgUnit } from "./ko/org-unit";
import { koBulkMove } from "./ko/bulk-move";
import { koPlacement } from "./ko/placement";
import { koSetup } from "./ko/setup";
import { koReason } from "./ko/reason";
import { koProfile } from "./ko/profile";
import { koIdentity } from "./ko/identity";
import { koRequests } from "./ko/requests";
import { koTitles } from "./ko/titles";
import { koRosterFields } from "./ko/roster-fields";
import { koOrgBulk } from "./ko/org-bulk";
import { koOrgHistory } from "./ko/org-history";
import { koOrgConflict } from "./ko/org-conflict";
import { koStructure } from "./ko/structure";
import { koStructureChart } from "./ko/structure-chart";
import { koUiOrgCanvas } from "./ko/ui-org-canvas";
import { koUiCommandPalette } from "./ko/ui-command-palette";
import { koCrud } from "./ko/crud";
import { koRegister } from "./ko/register";
import { koUnplaced } from "./ko/unplaced";
import { koBulkGrid } from "./ko/bulk-grid";
import { koDataHealth } from "./ko/data-health";
import { koUiRecord } from "./ko/ui-record";
import { koEmpCard } from "./ko/emp-card";
import { koEmpFix } from "./ko/emp-fix";
import { koEmpRec } from "./ko/emp-rec";
import { koEmpDoc } from "./ko/emp-doc";
import { koPeopleJump } from "./ko/people-jump";
import { koOvertimeAttestation } from "./ko/settings-hub.attestation";
import { koSettingsHub } from "./ko/settings-hub";
import { koUiWorklist } from "./ko/ui-worklist";
import { koUiLedger } from "./ko/ui-ledger";

export const ko: Record<ScreenMessageId, string> = {
  ...koUiFlexibleColumns,
  ...koSettingsHub,
  ...koOvertimeAttestation,
  ...koGovernanceRefusals,
  ...koAccountLinkRefusals,
  ...koPeriodUnlockRefusals,
  ...koLeave,
  ...koOrgChangeRefusals,
  ...koUiShiftBar,
  ...koStatutory,
  ...koFormat,
  ...koAsof,
  ...koHome,
  ...koApprovals,
  ...koOrg,
  ...koPeople,
  ...koExit,
  ...koAccounts,
  ...koAccess,
  ...koAccessReview,
  ...koAccessLog,
  ...koInternalCalendar,
  ...koBenefits,
  ...koAudit,
  ...koAccessCodes,
  ...koDenied,
  ...koAccessGrants,
  ...koAccount,
  ...koPeriodLocks,
  ...koAttendance,
  ...koAttendanceRefusals,
  ...koAttendanceSchedule,
  ...koAttendancePatterns,
  ...koAttendanceHolidays,
  ...koAttendanceCrews,
  ...koAttendanceRecords,
  ...koAttendanceOverview,
  ...koImport,
  ...koImportRollback,
  ...koImportSheet,
  ...koImportReview,
  ...koNotice,
  ...koRenew,
  ...koImportChanges,
  ...koImportValues,
  ...koImportJob,
  ...koImportReconcile,
  ...koIdentifiers,
  ...koTenants,
  ...koEnum,
  ...koLive,
  ...koUiField,
  ...koUiReason,
  ...koUiChoice,
  ...koUiDate,
  ...koUiBlocker,
  ...koUiConflict,
  ...koUiReceipt,
  ...koUiDeadlineChip,
  ...koUiChainStepper,
  ...koUiApprovalCard,
  ...koUiRecordVerbs,
  ...koUiRecordActions,
  ...koEmpContact,
  ...koEmpPhoto,
  ...koUiOverrideSheet,
  ...koUiHandoff,
  ...koUiLongTable,
  ...koUiServerPicker,
  ...koUiSetupRail,
  ...koUiStepLine,
  ...koUiSectionConfirm,
  ...koUiFileDrop,
  ...koUiCodePicker,
  ...koUiAddressField,
  ...koUiSheet,
  ...koComposer,
  ...koUiCrumbs,
  ...koRoster,
  ...koPerson,
  ...koFacts,
  ...koGroupTransfer,
  ...koLifecycle,
  ...koBulk,
  ...koOrgTree,
  ...koOrgPropose,
  ...koOrgChange,
  ...koUiTimelineLanes,
  ...koEntity,
  ...koWorkplace,
  ...koWorkplaceRegChange,
  ...koCapture,
  ...koEntityCreate,
  ...koEntityHistoryField,
  ...koEntityQuick,
  ...koEntityRecord,
  ...koEntityRecordClose,
  ...koEntityOps,
  ...koEntityReissue,
  ...koOrgStructure,
  ...koOrgUnit,
  ...koBulkMove,
  ...koPlacement,
  ...koSetup,
  ...koReason,
  ...koProfile,
  ...koIdentity,
  ...koRequests,
  ...koTitles,
  ...koRosterFields,
  ...koOrgBulk,
  ...koOrgHistory,
  ...koOrgConflict,
  ...koStructure,
  ...koStructureChart,
  ...koUiOrgCanvas,
  ...koUiCommandPalette,
  ...koCrud,
  ...koRegister,
  ...koUnplaced,
  ...koBulkGrid,
  ...koDataHealth,
  ...koTimeline,
  ...koRequestOutcome,
  ...koUiRecord,
  ...koEmpCard,
  ...koEmpFix,
  ...koEmpRec,
  ...koEmpDoc,
  ...koPeopleJump,
  ...koOpsRecovery,
  ...koNts, ...koPayroll, ...koPayrollOutlook, ...koPayrollRun, ...koPayslip,
  ...koCommon,
  ...koSupport,
  ...koSupportAccess,
  ...koPrivacyRefusals,
  ...koDirectoryViews,
  ...koUiWorklist,
  ...koUiLedger,
  ...koConsulting, ...koEvaluation, ...koMe, ...koTeam, ...koShellRoutes, ...koAccessPolicies, ...koAccessCheck, ...koAuth,
};
