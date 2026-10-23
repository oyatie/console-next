// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_gate_rls_arming::check_workspace;
use std::{fs, path::Path};

fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn follows_test_only_modules_without_exempting_production_names_or_features() {
    let root = std::env::temp_dir().join(format!("rls-arming-test-modules-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let mutation = "pub async fn fixture(pool: &PgPool) {\n    sqlx::query(\"UPDATE organizations SET name = 'x'\").execute(pool).await;\n}\n";
    for (dir, name) in [("app", "console-app"), ("crates/x/rest", "console-x-rest")] {
        write(
            &root,
            &format!("{dir}/Cargo.toml"),
            &format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n"),
        );
        write(
            &root,
            &format!("{dir}/src/lib.rs"),
            "#[cfg(test)]\nmod fixtures;\n#[cfg(any(test, feature = \"runtime\"))]\nmod live;\nmod production_tests;\n#[cfg(test)]\n#[path = \"shared.rs\"]\nmod test_shared;\n#[path = \"shared.rs\"]\nmod live_shared;\n",
        );
        write(
            &root,
            &format!("{dir}/src/fixtures.rs"),
            "#[path = \"nested.rs\"]\nmod child;\n",
        );
        write(&root, &format!("{dir}/src/nested.rs"), mutation);
        write(&root, &format!("{dir}/src/live.rs"), mutation);
        write(&root, &format!("{dir}/src/shared.rs"), mutation);
        write(&root, &format!("{dir}/src/production_tests.rs"), mutation);
    }
    let violations = check_workspace(&root).unwrap().violations;
    assert_eq!(violations.len(), 6, "{violations:#?}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn dev_dependency_only_crates_are_exempt_until_a_production_edge_exists() {
    let root = std::env::temp_dir().join(format!("rls-dev-only-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    write(&root, "app/src/lib.rs", "fn main() {}\n");
    write(
        &root,
        "app/Cargo.toml",
        "[package]\nname = \"console-app\"\n[dev-dependencies]\nfixtures = {}\n",
    );
    write(
        &root,
        "crates/fixtures/Cargo.toml",
        "[package]\nname = \"fixtures\"\n",
    );
    write(
        &root,
        "crates/fixtures/src/lib.rs",
        "fn seed(pool: &PgPool) { sqlx::query(\"UPDATE organizations SET name='x'\").execute(pool); }\n",
    );
    assert!(check_workspace(&root).unwrap().passed());
    write(
        &root,
        "app/Cargo.toml",
        "[package]\nname = \"console-app\"\n[dependencies]\nfixtures = {}\n",
    );
    assert_eq!(check_workspace(&root).unwrap().violations.len(), 1);
    fs::remove_dir_all(root).unwrap();
}
