// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "@playwright/test";
import { supportReferenceRoutes, supportReferenceTest, supportReferenceTitle } from "./support-ref";

for (const route of supportReferenceRoutes("b")) test(supportReferenceTitle(route, "failed"), supportReferenceTest(route, "failed"));
