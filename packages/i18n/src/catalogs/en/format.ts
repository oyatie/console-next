import type { koFormat } from "../ko/format";

export const enFormat: Partial<Record<keyof typeof koFormat, string>> = {
  "format.notComputable": "Not computable",
  "format.krw": "₩{amount, number}",
};
