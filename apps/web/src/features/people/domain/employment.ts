// SPDX-License-Identifier: LicenseRef-Proprietary
import { retirementDate } from "../../../lib/pure/employment";
export { retirementDate };

export const employedOn = (day: string, hire: string, lastWorkingDay?: string) =>
  hire <= day && (!lastWorkingDay || day < retirementDate(lastWorkingDay));
