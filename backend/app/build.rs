//! BG-3: embed the compile-time-checked queries (`backend/.sqlx`, the set
//! `sqlx::query!` was checked against) so `CONSOLE_APP_ROLE=schema-check`
//! can PREPARE them against a database with no files on disk.

use std::error::Error;
use std::fmt::Write as _;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.sqlx");
    println!("cargo::rerun-if-changed={}", dir.display());
    let mut queries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        let (Some(hash), Some(query)) = (json["hash"].as_str(), json["query"].as_str()) else {
            return Err(format!("{}: no hash or query", path.display()).into());
        };
        queries.push((hash.to_owned(), query.to_owned()));
    }
    queries.sort();
    let mut out = String::from("pub(crate) const CHECKED_QUERIES: &[(&str, &str)] = &[\n");
    for (hash, query) in queries {
        writeln!(out, "    ({hash:?}, {query:?}),")?;
    }
    out.push_str("];\n");
    std::fs::write(
        Path::new(&std::env::var("OUT_DIR")?).join("checked_queries.rs"),
        out,
    )?;
    Ok(())
}
