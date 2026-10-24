// SPDX-License-Identifier: LicenseRef-Proprietary
import { addDays } from "../../ui/date/days";

export const retirementDate = (lastWorkingDay: string) => addDays(lastWorkingDay, 1);
