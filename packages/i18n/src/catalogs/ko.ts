import { koNts } from "./ko/nts";
import { koSupport } from "./ko/support";
import { koSupportAccess } from "./ko/support-access";
import { koCommon } from "./ko/common";
import { koOpsRecovery } from "./ko/ops-recovery";
import { koImportRollback } from "./ko/import-rollback";
import { koComposer } from "./ko/composer";
import { koStatutory } from "./ko/statutory";
import { koRequestOutcome } from "./ko/request-outcome";
// Source catalog for the screens (Korean first); other locales translate these ids. Sign-in,
// shell and shared-state copy (app., auth., common., shell.) is in boot.ts. ICU MessageFormat;
// Korean particles via `{name|을를}`.
// Never put an ASCII apostrophe before `{` (ICU quoting) — use “ ” for quotes.
// One file per id prefix: `<ns>.` ids live in ko/<ns>.ts and en/<ns>.ts (kebab-case file name).
// A new namespace appends one import and one spread line here and in en.ts.
import { koFormat } from "./ko/format";
import { koAsof } from "./ko/asof";
import { koTimeline } from "./ko/timeline";
import { koHome } from "./ko/home";
import { koOrg } from "./ko/org";
import { koPeople } from "./ko/people";
import { koExit } from "./ko/exit";
import { koAccounts } from "./ko/accounts";
import { koAccess } from "./ko/access";
import { koAccessCodes } from "./ko/access-codes";
import { koDenied } from "./ko/denied";
import { koAccessGrants } from "./ko/access-grants";
import { koAccount } from "./ko/account";
import { koPeriodLocks } from "./ko/period-locks";
import { koAttendance } from "./ko/attendance";
import { koAttendanceSchedule } from "./ko/attendance-schedule";
import { koAttendancePatterns } from "./ko/attendance-patterns";
import { koAttendanceHolidays } from "./ko/attendance-holidays";
import { koAttendanceCrews } from "./ko/attendance-crews";
import { koAttendanceRecords } from "./ko/attendance-records";
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
import { koUiSourceChip } from "./ko/ui-source-chip";
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
import { koUiRecord } from "./ko/ui-record";
import { koEmpCard } from "./ko/emp-card";
import { koEmpFix } from "./ko/emp-fix";
import { koEmpRec } from "./ko/emp-rec";
import { koEmpDoc } from "./ko/emp-doc";
import { koPeopleJump } from "./ko/people-jump";

export const ko = {
  ...koStatutory,
  ...koFormat,
  ...koAsof,
  ...koHome,
  ...koOrg,
  ...koPeople,
  ...koExit,
  ...koAccounts,
  ...koAccess,
  ...koAccessCodes,
  ...koDenied,
  ...koAccessGrants,
  ...koAccount,
  ...koPeriodLocks,
  ...koAttendance,
  ...koAttendanceSchedule,
  ...koAttendancePatterns,
  ...koAttendanceHolidays,
  ...koAttendanceCrews,
  ...koAttendanceRecords,
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
  ...koUiSourceChip,
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
  ...koTimeline,
  ...koRequestOutcome,
  ...koUiRecord,
  ...koEmpCard,
  ...koEmpFix,
  ...koEmpRec,
  ...koEmpDoc,
  ...koPeopleJump,
  ...koOpsRecovery,
  ...koNts,
  ...koCommon,
  ...koSupport,
  ...koSupportAccess,
} as const;

export type ScreenMessageId = keyof typeof ko;
