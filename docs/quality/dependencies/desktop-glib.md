<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Dependabot alert #14 identifies glib in apps/desktop/src-tauri/Cargo.lock. It is part of Tauri's Linux GTK chain. The [desktop scope](../../../apps/desktop/README.md) records ADR-014's Windows x64-only release target; Linux shells are outside the MVP. This dependency is not built into the shipped Windows target.

Provenance: The desktop lockfile records glib 0.18.5 from crates.io. The lockfile retains dependencies for multiple platforms, including targets that are not shipped.

License: MIT, as declared by [glib's registry metadata](https://crates.io/crates/glib/0.18.5).

Security: Proposed dismissal for unused code, owned by Jason Lee. This records the reason for review; it does not dismiss the GitHub alert. The orchestrator performs that action after review.

Reopen condition: Reopen alert #14 and resolve the affected GTK chain before a Linux desktop shell is planned, built or shipped. The exception applies only to the current Windows release target.
