// SPDX-License-Identifier: LicenseRef-Proprietary
import { label, labeled, type Enum } from "../lib/labels";
import { Chip } from "./chip";

/** Unknown response codes stay visible without becoming the sentence's label. */
export function EnumCode({ e, value }: { e: Enum; value?: string | null }) {
  const code = value == null ? undefined : labeled(e, value).code;
  return code ? <Chip tone="neutral">{code}</Chip> : null;
}

export function EnumValue({ e, value }: { e: Enum; value: string }) {
  return <>{label(e, value)} <EnumCode e={e} value={value} /></>;
}
