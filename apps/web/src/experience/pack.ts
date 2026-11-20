// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { screen } from "../lib/fonts";
import { resolveExperience, type experiences } from "./table";

type ExperienceId = (typeof experiences)[number]["id"];
type ShellProps = { children?: ReactNode; pending?: boolean };
type ShellComponent = ComponentType<ShellProps>;
type PackLoader = () => Promise<{ default: ShellComponent }>;

const baselineLoader: PackLoader = () => import("../shell/baseline/shell");
const consoleLoader: PackLoader = () =>
  import("../shell/console/shell").then(m => ({ default: m.ConsoleShell }));
const BaselineShell: LazyExoticComponent<ShellComponent> = lazy(screen(baselineLoader));
const ConsoleShell: LazyExoticComponent<ShellComponent> = lazy(screen(consoleLoader));

const packs = {
  baseline: baselineLoader,
  console: consoleLoader,
  "warm-clear": baselineLoader,
} satisfies Record<ExperienceId, PackLoader>;

const shells = {
  baseline: BaselineShell,
  console: ConsoleShell,
  "warm-clear": BaselineShell,
} satisfies Record<ExperienceId, LazyExoticComponent<ShellComponent>>;

export function loadPack(id?: string) {
  const current = id ?? (typeof document === "undefined" ? undefined : document.documentElement.dataset.experience);
  return packs[resolveExperience(current).id]();
}

export function ExperienceShell({ experienceId, ...props }: ShellProps & { experienceId: ExperienceId }) {
  return createElement(shells[resolveExperience(experienceId).id], props);
}
