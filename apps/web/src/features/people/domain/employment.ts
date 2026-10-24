// SPDX-License-Identifier: LicenseRef-Proprietary
import { addDays } from "../../../ui/date/days";

export const retirementDate = (lastWorkingDay: string) => addDays(lastWorkingDay, 1);

export const employedOn = (day: string, hire: string, lastWorkingDay?: string) =>
  hire <= day && (!lastWorkingDay || day < retirementDate(lastWorkingDay));
