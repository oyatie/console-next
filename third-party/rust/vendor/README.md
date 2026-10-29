# Rust third-party vendor patches

Temporary crates.io patches used only when the published dependency graph cannot satisfy CI/security policy.

This directory is the single repository-owned source boundary for those
patches. Cargo references it from `backend/Cargo.toml`; Reindeer and Buck2 can
materialize it without crossing out of `third-party/rust`; and the backend
image copies the same audited bytes. Do not create a second backend-local
vendor copy.

## quick-xml RUSTSEC unblock

`calamine 0.35.0` depends on `quick-xml ^0.39` and `umya-spreadsheet 3.0.0` depends on `quick-xml ^0.37.1`. Both ranges resolve to versions below the fixed `quick-xml >=0.41.0` line for RUSTSEC-2026-0194/RUSTSEC-2026-0195.

The local patches are:

- `calamine-0.35.0-quickxml41`: published `calamine 0.35.0` with its `quick-xml` dependency raised to `0.41.0`.
- `umya-spreadsheet-3.0.0-quickxml41`: published `umya-spreadsheet 3.0.0` with its `quick-xml` dependency raised to `0.41.0`.
- `quick-xml-0.41.0-compat`: published `quick-xml 0.41.0` plus a small `BytesText::unescape` compatibility shim for `umya-spreadsheet`'s pre-0.41 API usage.

Remove these patches once upstream crates.io releases allow the workspace to resolve `quick-xml >=0.41.0` without local shims.

## zip dual-header security fix

Both spreadsheet patches require `zip >=9.0.5` (within major 9) for
[GHSA-m665-v7pm-7grj](https://github.com/zip-rs/zip2/security/advisories/GHSA-m665-v7pm-7grj).
The backend and fuzz lockfiles resolve 9.1.3. Import and template round-trip
regressions change a local ZIP filename while preserving its central-directory
name and payload; the readers must refuse these inconsistent archives.
Zip 9 makes decoded filenames fallible: the patches propagate decoding errors
from path-cache construction and picture/entry lookup, preserving error handling.
Its header checks are opt-in: each reader validates the complete archive before
reading spreadsheet parts, including local filenames and compression methods.
The desktop workspace uses upstream `tauri-plugin-updater 2.14.1`, which also
accepts zip 9. Existing ZIP advisory exceptions are removed from both scanners.
