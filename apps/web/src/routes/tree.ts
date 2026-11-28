// SPDX-License-Identifier: LicenseRef-Proprietary
import { app, frame, root } from "./app";
import { orgRoutes } from "./org";
import { peopleRoutes } from "./people";
import { identifierRoutes } from "./identifiers";
import { entityRoutes } from "./entity";
import { onboardingRoutes } from "./onboarding";
import { accessRoutes } from "./access";
import { auditRoutes } from "./audit";
import { orgBulkRoutes } from "./org-bulk";
import { requestRoutes } from "./requests";
import { attendanceRoutes } from "./attendance";
import { companyDomainRoute } from "./company-domain";
import { statutoryRoute } from "./statutory";
import { overtimeSettingsRoute, settingsRoute } from "./settings";
import { payrollRoutes } from "./payroll";
import { inboxRoute } from "./inbox";
import { approvalsRoute, approvalNewRoute, approvalViewerRoute } from "./approvals";
import { leaveRoute } from "./leave";
import { payslipsRoute } from "./payslips";
import { meRoutes } from "./me";
import { teamRoutes } from "./team";

export const routeTree = root.addChildren([...frame.signIn, app.addChildren([...frame.screens, ...payrollRoutes, ...orgRoutes, ...entityRoutes, ...onboardingRoutes, companyDomainRoute, ...peopleRoutes, ...identifierRoutes, ...accessRoutes, ...auditRoutes, ...orgBulkRoutes, ...requestRoutes, ...attendanceRoutes, statutoryRoute, settingsRoute, overtimeSettingsRoute, inboxRoute, approvalsRoute, approvalNewRoute, approvalViewerRoute, leaveRoute, payslipsRoute, ...meRoutes, ...teamRoutes])]);
