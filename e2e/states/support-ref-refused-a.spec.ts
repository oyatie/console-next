// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "@playwright/test";
import { supportReferenceRoutes, supportReferenceTest, supportReferenceTitle } from "./support-ref";

for (const route of supportReferenceRoutes("a")) test(supportReferenceTitle(route, "refused"), supportReferenceTest(route, "refused"));
