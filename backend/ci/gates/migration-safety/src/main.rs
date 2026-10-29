//! CI entry point for the migration-safety gate.

use console_gate_migration_safety::{order, summary};

use std::path::Path;

fn main() {
    let workspace_dir = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("ERROR: cannot determine cwd: {e}");
            std::process::exit(1);
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => run_gate(&workspace_dir),
        [flag, base] if flag == "--summary" => match summary(&workspace_dir, base) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("ERROR: {error}");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("usage: console-gate-migration-safety [--summary <base-ref>]");
            std::process::exit(1);
        }
    }
}

fn run_gate(workspace_dir: &Path) {
    eprintln!(
        "console-gate-migration-safety: checking workspace at {}",
        workspace_dir.display()
    );

    let result = console_gate_migration_safety::check_workspace(workspace_dir)
        .and_then(|result| {
            order::check(workspace_dir)?;
            Ok(result)
        })
        .unwrap_or_else(|e| {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        });

    if result.passed() {
        eprintln!("console-gate-migration-safety: PASSED");
        eprintln!(
            "Expand is an author declaration, not proof of behavioural compatibility: CREATE OR REPLACE FUNCTION/VIEW requires the N-1 rehearsal."
        );
        std::process::exit(0);
    }

    eprintln!(
        "console-gate-migration-safety: FAILED - {} violation(s):",
        result.violations.len()
    );
    for violation in &result.violations {
        eprintln!("  {violation}");
    }
    std::process::exit(1);
}
