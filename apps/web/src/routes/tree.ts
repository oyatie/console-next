// SPDX-License-Identifier: LicenseRef-Proprietary
import { app, frame, root } from "./app";
import { orgRoutes } from "./org";
import { peopleRoutes } from "./people";
import { identifierRoutes } from "./identifiers";
import { entityRoutes } from "./entity";
import { onboardingRoutes } from "./onboarding";
import { accessRoutes } from "./access";
import { orgBulkRoutes } from "./org-bulk";
import { requestRoutes } from "./requests";
import { attendanceRoutes } from "./attendance";
import { companyDomainRoute } from "./company-domain";
import { statutoryRoute } from "./statutory";
import { settingsRoute } from "./settings";
import { inboxRoute } from "./inbox";

export const routeTree = root.addChildren([...frame.signIn, app.addChildren([...frame.screens, ...orgRoutes, ...entityRoutes, ...onboardingRoutes, companyDomainRoute, ...peopleRoutes, ...identifierRoutes, ...accessRoutes, ...orgBulkRoutes, ...requestRoutes, ...attendanceRoutes, statutoryRoute, settingsRoute, inboxRoute])]);
