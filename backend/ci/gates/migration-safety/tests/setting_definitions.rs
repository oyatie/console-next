// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_gate_migration_safety::check_migrations_root;

#[test]
fn definition_snapshots_and_unmarked_removals_are_refused() {
    let root = std::env::temp_dir().join(format!("migration-settings-{}", std::process::id()));
    let migrations = root.join("migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    let file = migrations.join("20261118000000000_definitions.sql");
    let header = "-- migration-class: contract — Preserve the lookup contract.\n-- contract-of: 20261117160918000\n";
    for sql in [
        "CREATE OR REPLACE FUNCTION setting_definition(p_key text) RETURNS text LANGUAGE sql AS $$ SELECT 'lost' $$;",
        "CREATE FUNCTION public.\"setting_definition\"(text) RETURNS text LANGUAGE sql AS $$ SELECT 'lost' $$;",
        "DROP FUNCTION IF EXISTS public.setting_definition(text);",
        "DROP FUNCTION unrelated(), public.setting_definition(text);",
        "DROP TABLE unrelated, public.setting_definitions;",
        "TRUNCATE unrelated, public.setting_definitions;",
        "DROP TABLE IF EXISTS public.\"setting_definitions\";",
        "DELETE FROM ONLY public.setting_definitions WHERE key = 'removed';",
        "TRUNCATE TABLE public.setting_definitions;",
    ] {
        std::fs::write(&file, format!("{header}{sql}")).unwrap();
        let result = check_migrations_root(&root);
        assert!(
            result
                .violations
                .iter()
                .any(|v| format!("{:?}", v.kind) == "SettingDefinitionRewrite"),
            "accepted {sql}: {result:?}"
        );
    }
    for sql in [
        "INSERT INTO setting_definitions(key) VALUES ('new');",
        "UPDATE setting_definitions SET retired_at = now() WHERE key = 'retired';",
        "-- CREATE OR REPLACE FUNCTION setting_definition(text)\nSELECT 'DELETE FROM setting_definitions';",
        "-- setting-definitions-removal: The previous release retired this key.\nDELETE FROM setting_definitions WHERE key = 'retired';",
    ] {
        std::fs::write(&file, format!("{header}{sql}")).unwrap();
        assert!(check_migrations_root(&root).passed(), "rejected {sql}");
    }
    // A removal exception cannot authorize a return to whole-function snapshots.
    std::fs::write(&file, format!("{header}-- setting-definitions-removal: obsolete\nDROP FUNCTION setting_definition(text);")).unwrap();
    assert!(!check_migrations_root(&root).passed());
    std::fs::remove_file(file).unwrap();
    std::fs::write(migrations.join("20261117160918000_transition.sql"), format!("{header}CREATE OR REPLACE FUNCTION setting_definition(text) RETURNS text LANGUAGE sql AS $$ SELECT 'old' $$;")).unwrap();
    assert!(check_migrations_root(&root).passed());
    std::fs::remove_dir_all(root).unwrap();
}
