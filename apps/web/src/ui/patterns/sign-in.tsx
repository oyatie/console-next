// SPDX-License-Identifier: LicenseRef-Proprietary
import { useActiveExperienceId } from "../../experience/dom";
import { PageHead } from "../page-head/page-head";
import { shown } from "../shown";
import type { SignInPatternProps } from "./sign-in-contract";
import s from "./sign-in.module.css";

/**
 * SignIn (`P11`) arrangement: standalone centered card outside `ExperienceShell` (`<main data-pattern="sign-in">`),
 * withholding interactive controls during initial `loading` and rendering `notices`, `body`, `secondary`, and `foot`.
 */
export function SignInPattern({
  title,
  titleId,
  context,
  busy = false,
  loading,
  notices,
  body,
  secondary,
  foot,
  facts: _facts,
  overlays,
  baseline,
}: SignInPatternProps) {
  const experience = useActiveExperienceId();
  if (baseline && experience === "baseline") {
    return <>{baseline()}</>;
  }

  return (
    <main className={s.root} data-pattern="sign-in" data-floorplan="sign-in">
      {shown(loading) ? (
        <div className={s.frame}>{loading}</div>
      ) : (
        <div className={s.card} aria-busy={busy || undefined}>
          <div className={s.head}>
            <PageHead title={title} titleId={titleId} meta={context} />
          </div>
          {shown(notices) ? <div className={s.notices}>{notices}</div> : null}
          <div className={s.body}>{body}</div>
          {shown(secondary) ? <div className={s.secondary}>{secondary}</div> : null}
          {shown(foot) ? <div className={s.foot}>{foot}</div> : null}
        </div>
      )}
      {overlays}
    </main>
  );
}
