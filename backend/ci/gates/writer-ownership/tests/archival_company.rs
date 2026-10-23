// SPDX-License-Identifier: LicenseRef-Proprietary
//! The legacy table has no current writer, including its former owning crate.
use console_gate_writer_ownership::scan;
use std::fs;
use std::path::Path;

fn copy_sources(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_sources(&source, &target)?;
        } else if source.extension().is_some_and(|ext| ext == "rs") {
            fs::copy(source, target)?;
        }
    }
    Ok(())
}

#[test]
fn former_owner_cannot_reintroduce_a_company_fact_writer() -> Result<(), Box<dyn std::error::Error>>
{
    let root =
        std::env::temp_dir().join(format!("company-archive-ownership-{}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    let subject = root.join("subject");
    // Scan the real former owner under an unprivileged crate identity, so the
    // existing SQL parser charges its writes too. Other crates are already gated.
    copy_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../crates/ontology/canonical-adapter-postgres/src"),
        &subject.join("src"),
    )?;
    fs::write(
        subject.join("Cargo.toml"),
        "[package]\nname = \"company-archive-audit\"\nversion = \"0.1.0\"\n",
    )?;
    let report = scan(&root)?;
    assert!(report.scanned_files > 0);
    let writers: Vec<_> = report
        .violations
        .iter()
        .filter(|v| v.table == "company_revisions")
        .collect();
    fs::remove_dir_all(&root)?;
    assert!(
        writers.is_empty(),
        "archived legal facts acquired a production writer: {writers:?}"
    );
    Ok(())
}
