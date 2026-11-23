// SPDX-License-Identifier: LicenseRef-Proprietary
import type { SetupStepView } from "./setup-rail";

export const currentStep = (steps: readonly Pick<SetupStepView, "key" | "state">[]) =>
  steps.find((x) => x.state !== "done" && x.state !== "attention")?.key;
