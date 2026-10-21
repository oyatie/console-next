// SPDX-License-Identifier: LicenseRef-Proprietary
//! Forbidden external dependencies: the domain purity rule, and stacker confined to
//! platform/authz (AD-F21f).

use super::*;

// ---------------------------------------------------------------------------
// Purity rule: domain layer forbids sqlx/axum/tokio as external deps
// (Validated via classify + forbidden_external_deps; no real dep resolution
//  needed — the gate enforces this at metadata parse time.)
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_domain_depending_on_sqlx() {
    let layer = classify_crate(
        "console-workorder-domain",
        "/fake/ws/crates/workorder/domain/Cargo.toml",
        "/fake/ws",
    );
    assert_eq!(layer, Layer::Domain);
    let forbidden = layer.forbidden_external_deps();
    assert!(
        forbidden.contains(&"sqlx"),
        "domain should forbid sqlx; got {forbidden:?}"
    );
    assert!(
        forbidden.contains(&"axum"),
        "domain should forbid axum; got {forbidden:?}"
    );
    assert!(
        forbidden.contains(&"tokio"),
        "domain should forbid tokio; got {forbidden:?}"
    );
}

// ---------------------------------------------------------------------------
// Framework confinement: stacker belongs only to platform/authz
// ---------------------------------------------------------------------------

#[test]
fn gate_confines_stacker_to_platform_authz() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("stacker-confinement")?;
    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = ["crates/platform/authz", "crates/platform/db"]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    for name in ["authz", "db"] {
        let dir = ws.join("crates/platform").join(name);
        write_file(
            &dir.join("Cargo.toml"),
            &format!(
                r#"
[package]
name = "console-platform-{name}"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[dependencies]
stacker = "=0.1.24"

[lints]
workspace = true
"#
            ),
        )?;
        write_file(&dir.join("src/lib.rs"), "// platform fixture\n")?;
    }

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);
    assert!(!result.passed(), "stacker outside authz must fail the gate");
    assert_eq!(
        result.violations.len(),
        1,
        "only db → stacker should fail; authz → stacker must pass: {:#?}",
        result.violations
    );
    let violation = &result.violations[0];
    assert_eq!(violation.kind, ViolationKind::ForbiddenExternalDep);
    assert_eq!(violation.crate_name, "console-platform-db");
    assert!(
        violation.detail.contains("stacker"),
        "violation must name stacker: {violation:#?}"
    );
    fs::remove_dir_all(&ws)?;
    Ok(())
}
