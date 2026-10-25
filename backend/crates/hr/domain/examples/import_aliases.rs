// SPDX-License-Identifier: LicenseRef-Proprietary
//! Regenerate the shared client import aliases from their owning domain catalog.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = serde_json::to_string_pretty(&serde_json::json!({
        "_license": "SPDX-License-Identifier: LicenseRef-Proprietary",
        "_generated_by": "console-hr-domain example import_aliases; edit import/fields.rs or fields_org.rs",
        "aliases": console_hr_domain::import::fields_org::aliases(),
    }))? + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../apps/web/src/reference/import/aliases.json");
    std::fs::create_dir_all(path.parent().ok_or("aliases have no parent directory")?)?;
    std::fs::write(path, source)?;
    Ok(())
}
