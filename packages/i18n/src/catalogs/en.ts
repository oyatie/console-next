import { enCommon } from "./en/common";
import { enOpsRecovery } from "./en/ops-recovery";
import { enStatutory } from "./en/statutory";
import { enRequestOutcome } from "./en/request-outcome";
import type { ScreenMessageId } from "./ko";
import { enFormat } from "./en/format";
import { enAsof } from "./en/asof";
import { enTimeline } from "./en/timeline";
import { enHome } from "./en/home";
import { enOrg } from "./en/org";
import { enPeople } from "./en/people";
import { enExit } from "./en/exit";
import { enAccounts } from "./en/accounts";
import { enAccess } from "./en/access";
import { enAccessCodes } from "./en/access-codes";
import { enDenied } from "./en/denied";
import { enAccessGrants } from "./en/access-grants";
import { enAccount } from "./en/account";
import { enPeriodLocks } from "./en/period-locks";
import { enAttendance } from "./en/attendance";
import { enAttendanceSchedule } from "./en/attendance-schedule";
import { enAttendancePatterns } from "./en/attendance-patterns";
import { enAttendanceHolidays } from "./en/attendance-holidays";
import { enAttendanceCrews } from "./en/attendance-crews";
import { enAttendanceRecords } from "./en/attendance-records";
import { enImport } from "./en/import";
import { enImportSheet } from "./en/import-sheet";
import { enImportReview } from "./en/import-review";
import { enNotice } from "./en/notice";
import { enRenew } from "./en/renew";
import { enImportChanges } from "./en/import-changes";
import { enImportValues } from "./en/import-values";
import { enImportJob } from "./en/import-job";
import { enImportReconcile } from "./en/import-reconcile";
import { enIdentifiers } from "./en/identifiers";
import { enTenants } from "./en/tenants";
import { enEnum } from "./en/enum";
import { enLive } from "./en/live";
import { enUiField } from "./en/ui-field";
import { enUiReason } from "./en/ui-reason";
import { enUiChoice } from "./en/ui-choice";
import { enUiDate } from "./en/ui-date";
import { enUiBlocker } from "./en/ui-blocker";
import { enUiConflict } from "./en/ui-conflict";
import { enUiReceipt } from "./en/ui-receipt";
import { enUiDeadlineChip } from "./en/ui-deadline-chip";
import { enUiChainStepper } from "./en/ui-chain-stepper";
import { enUiApprovalCard } from "./en/ui-approval-card";
import { enUiRecordVerbs } from "./en/ui-record-verbs";
import { enUiRecordActions } from "./en/ui-record-actions";
import { enEmpContact } from "./en/emp-contact";
import { enEmpPhoto } from "./en/emp-photo";
import { enUiOverrideSheet } from "./en/ui-override-sheet";
import { enUiHandoff } from "./en/ui-handoff";
import { enUiLongTable } from "./en/ui-long-table";
import { enUiServerPicker } from "./en/ui-server-picker";
import { enUiSetupRail } from "./en/ui-setup-rail";
import { enUiSourceChip } from "./en/ui-source-chip";
import { enUiSectionConfirm } from "./en/ui-section-confirm";
import { enUiFileDrop } from "./en/ui-file-drop";
import { enUiCodePicker } from "./en/ui-code-picker";
import { enUiAddressField } from "./en/ui-address-field";
import { enUiSheet } from "./en/ui-sheet";
import { enUiCrumbs } from "./en/ui-crumbs";
import { enRoster } from "./en/roster";
import { enPerson } from "./en/person";
import { enFacts } from "./en/facts";
import { enGroupTransfer } from "./en/group-transfer";
import { enLifecycle } from "./en/lifecycle";
import { enBulk } from "./en/bulk";
import { enOrgTree } from "./en/org-tree";
import { enOrgPropose } from "./en/org-propose";
import { enOrgChange } from "./en/org-change";
import { enUiTimelineLanes } from "./en/ui-timeline-lanes";
import { enEntity } from "./en/entity";
import { enWorkplace } from "./en/workplace";
import { enCapture } from "./en/capture";
import { enEntityCreate } from "./en/entity-create";
import { enEntityQuick } from "./en/entity-quick";
import { enEntityRecord } from "./en/entity-record";
import { enEntityRecordClose } from "./en/entity-record-close";
import { enEntityOps } from "./en/entity-ops";
import { enEntityReissue } from "./en/entity-reissue";
import { enOrgStructure } from "./en/org-structure";
import { enOrgUnit } from "./en/org-unit";
import { enBulkMove } from "./en/bulk-move";
import { enPlacement } from "./en/placement";
import { enSetup } from "./en/setup";
import { enReason } from "./en/reason";
import { enProfile } from "./en/profile";
import { enIdentity } from "./en/identity";
import { enRequests } from "./en/requests";
import { enTitles } from "./en/titles";
import { enOrgBulk } from "./en/org-bulk";
import { enOrgHistory } from "./en/org-history";
import { enOrgConflict } from "./en/org-conflict";
import { enStructure } from "./en/structure";
import { enStructureChart } from "./en/structure-chart";
import { enUiOrgCanvas } from "./en/ui-org-canvas";
import { enUiCommandPalette } from "./en/ui-command-palette";
import { enCrud } from "./en/crud";
import { enRegister } from "./en/register";
import { enUnplaced } from "./en/unplaced";
import { enBulkGrid } from "./en/bulk-grid";
import { enUiRecord } from "./en/ui-record";
import { enEmpCard } from "./en/emp-card";
import { enEmpFix } from "./en/emp-fix";
import { enEmpRec } from "./en/emp-rec";
import { enEmpDoc } from "./en/emp-doc";
import { enPeopleJump } from "./en/people-jump";

// Partial: missing ids fall back to Korean (index.test.ts fails on any).
export const en: Partial<Record<ScreenMessageId, string>> = {
  ...enStatutory,
  ...enFormat,
  ...enAsof,
  ...enHome,
  ...enOrg,
  ...enPeople,
  ...enExit,
  ...enAccounts,
  ...enAccess,
  ...enAccessCodes,
  ...enDenied,
  ...enAccessGrants,
  ...enAccount,
  ...enPeriodLocks,
  ...enAttendance,
  ...enAttendanceSchedule,
  ...enAttendancePatterns,
  ...enAttendanceHolidays,
  ...enAttendanceCrews,
  ...enAttendanceRecords,
  ...enImport,
  ...enImportSheet,
  ...enImportReview,
  ...enNotice,
  ...enRenew,
  ...enImportChanges,
  ...enImportValues,
  ...enImportJob,
  ...enImportReconcile,
  ...enIdentifiers,
  ...enTenants,
  ...enEnum,
  ...enLive,
  ...enUiField,
  ...enUiReason,
  ...enUiChoice,
  ...enUiDate,
  ...enUiBlocker,
  ...enUiConflict,
  ...enUiReceipt,
  ...enUiDeadlineChip,
  ...enUiChainStepper,
  ...enUiApprovalCard,
  ...enUiRecordVerbs,
  ...enUiRecordActions,
  ...enEmpContact,
  ...enEmpPhoto,
  ...enUiOverrideSheet,
  ...enUiHandoff,
  ...enUiLongTable,
  ...enUiServerPicker,
  ...enUiSetupRail,
  ...enUiSourceChip,
  ...enUiSectionConfirm,
  ...enUiFileDrop,
  ...enUiCodePicker,
  ...enUiAddressField,
  ...enUiSheet,
  ...enUiCrumbs,
  ...enRoster,
  ...enPerson,
  ...enFacts,
  ...enGroupTransfer,
  ...enLifecycle,
  ...enBulk,
  ...enOrgTree,
  ...enOrgPropose,
  ...enOrgChange,
  ...enUiTimelineLanes,
  ...enEntity,
  ...enWorkplace,
  ...enCapture,
  ...enEntityCreate,
  ...enEntityQuick,
  ...enEntityRecord,
  ...enEntityRecordClose,
  ...enEntityOps,
  ...enEntityReissue,
  ...enOrgStructure,
  ...enOrgUnit,
  ...enBulkMove,
  ...enPlacement,
  ...enSetup,
  ...enReason,
  ...enProfile,
  ...enIdentity,
  ...enRequests,
  ...enTitles,
  ...enOrgBulk,
  ...enOrgHistory,
  ...enOrgConflict,
  ...enStructure,
  ...enStructureChart,
  ...enUiOrgCanvas,
  ...enUiCommandPalette,
  ...enCrud,
  ...enRegister,
  ...enUnplaced,
  ...enBulkGrid,
  ...enTimeline,
  ...enRequestOutcome,
  ...enUiRecord,
  ...enEmpCard,
  ...enEmpFix,
  ...enEmpRec,
  ...enEmpDoc,
  ...enPeopleJump,
  ...enOpsRecovery,
  ...enCommon,
};
