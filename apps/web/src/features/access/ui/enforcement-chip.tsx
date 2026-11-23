// SPDX-License-Identifier: LicenseRef-Proprietary
import { EnumValue } from "../../../ui/enum-value";
import { ACCESS_ENFORCEMENT } from "../../../lib/labels";

/** Standalone enforcement chip so holder lists avoid pulling Avatar/holder standing-text graphs. */
export const EnforcementChip = ({ e }: { e: string }) => <EnumValue e={ACCESS_ENFORCEMENT} value={e} />;
