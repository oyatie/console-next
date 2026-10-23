// SPDX-License-Identifier: LicenseRef-Proprietary
//! Keep the calendar setting's allowed values in sync with the installed IANA catalog.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let zones: Vec<_> = chrono_tz::TZ_VARIANTS
        .iter()
        .map(|zone| zone.name())
        .collect();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").ok_or("Cargo OUT_DIR")?);
    std::fs::write(
        out.join("time_zones.rs"),
        format!("pub(super) const TIME_ZONES: &[&str] = &{zones:?};\n"),
    )?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
