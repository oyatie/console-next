// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "../schema";

export type OrgChangeDetail = components["schemas"]["OrgChangeDetail"];
export type SoleHolderDecision = NonNullable<OrgChangeDetail["sole_holder_decision"]>;
export type SoleHolderException = NonNullable<OrgChangeDetail["sole_holder_exception"]>;
