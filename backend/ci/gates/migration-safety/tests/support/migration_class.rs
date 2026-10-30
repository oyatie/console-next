// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

pub type TestResult = Result<(), Box<dyn std::error::Error>>;
// Always beyond the configured cutoff, without copying its value into fixtures.
pub const NEW_VERSION: i64 = 10_i64.pow(17) - 10;

pub struct Fixture(pub PathBuf);
impl Fixture {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "migration-class-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("migrations"))?;
        Ok(Self(root))
    }
    pub fn write(&self, version: i64, sql: &str) -> TestResult {
        fs::write(
            self.0.join(format!("migrations/{version:017}_fixture.sql")),
            sql,
        )?;
        Ok(())
    }
    pub fn git(&self, args: &[&str]) -> TestResult {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }
    pub fn commit(&self) -> TestResult {
        self.git(&["add", "."])?;
        self.git(&[
            "-c",
            "user.name=Jason Lee",
            "-c",
            "user.email=56489493+jason931225@users.noreply.github.com",
            "commit",
            "--quiet",
            "-m",
            "test: migration fixture",
        ])
    }
    pub fn summary(&self, base: &str) -> Result<Output, std::io::Error> {
        Command::new(env!("CARGO_BIN_EXE_console-gate-migration-safety"))
            .args(["--summary", base])
            .env_remove("MIGRATION_BASE")
            .current_dir(&self.0)
            .output()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
