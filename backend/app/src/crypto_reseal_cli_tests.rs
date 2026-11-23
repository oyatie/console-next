// SPDX-License-Identifier: LicenseRef-Proprietary
use uuid::Uuid;

use super::{
    CLI_DEFAULT_MAX_BATCHES_PER_ORG, CryptoCliCommand, DEFAULT_BATCH_SIZE, parse_cli_command,
    parse_cli_limits,
};
use crate::crypto_reseal_rotation::CryptoScopeSelection;
use crate::error::AppError;

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn parse_cli_limits_uses_defaults_when_no_flags_supplied() {
    assert_eq!(
        parse_cli_limits(&[]).unwrap(),
        (DEFAULT_BATCH_SIZE, CLI_DEFAULT_MAX_BATCHES_PER_ORG)
    );
}

#[test]
fn parse_cli_limits_accepts_space_and_equals_flags() {
    assert_eq!(
        parse_cli_limits(&args(&["--batch-size", "25", "--max-batches", "7"])).unwrap(),
        (25, 7)
    );
    assert_eq!(
        parse_cli_limits(&args(&["--batch-size=50", "--max-batches=12"])).unwrap(),
        (50, 12)
    );
    assert_eq!(
        parse_cli_limits(&args(&["--batch-size", "1", "--max-batches=3"])).unwrap(),
        (1, 3)
    );
}

#[test]
fn parse_cli_limits_rejects_invalid_and_unknown_flags() {
    for case in [
        vec!["--batch-size", "0"],
        vec!["--batch-size=0"],
        vec!["--max-batches", "0"],
        vec!["--max-batches=0"],
        vec!["--batch-size", "-5"],
        vec!["--batch-size=-5"],
        vec!["--max-batches", "-1"],
        vec!["--max-batches=-1"],
        vec!["--batch-size", "abc"],
        vec!["--batch-size=abc"],
        vec!["--max-batches", "xyz"],
        vec!["--max-batches=xyz"],
        vec!["--batch-size"],
        vec!["--batch-size="],
        vec!["--max-batches"],
        vec!["--max-batches="],
        vec!["--batch-size", "--max-batches", "5"],
        vec!["--unknown"],
        vec!["--unknown=1"],
        vec!["positional"],
    ] {
        let err = parse_cli_limits(&args(&case)).unwrap_err();
        assert!(
            matches!(err, AppError::Config(_)),
            "expected Config error for {case:?}, got {err:?}"
        );
    }
}

#[test]
fn parse_cli_command_validates_reseal_census_rotate_and_rewrap() {
    assert_eq!(
        parse_cli_command("crypto-reseal", &[]).unwrap(),
        CryptoCliCommand::Reseal {
            batch_size: DEFAULT_BATCH_SIZE,
            max_batches: CLI_DEFAULT_MAX_BATCHES_PER_ORG,
        }
    );
    assert_eq!(
        parse_cli_command(
            "crypto-reseal",
            &args(&["--batch-size=20", "--max-batches", "4"])
        )
        .unwrap(),
        CryptoCliCommand::Reseal {
            batch_size: 20,
            max_batches: 4,
        }
    );
    assert_eq!(
        parse_cli_command("crypto-census", &[]).unwrap(),
        CryptoCliCommand::Census
    );
    for rejected in [
        vec!["--batch-size", "10"],
        vec!["--batch-size=10"],
        vec!["--max-batches", "2"],
        vec!["--max-batches=2"],
        vec!["--unknown"],
    ] {
        assert!(matches!(
            parse_cli_command("crypto-census", &args(&rejected)),
            Err(AppError::Config(_))
        ));
    }

    let org = Uuid::new_v4();
    let org_str = org.to_string();
    assert_eq!(
        parse_cli_command("rotate-tenant-dek", &args(&["--org", &org_str])).unwrap(),
        CryptoCliCommand::RotateTenantDek {
            org_id: org,
            scope: CryptoScopeSelection::All,
        }
    );
    assert_eq!(
        parse_cli_command(
            "rotate-tenant-dek",
            &args(&[&format!("--org={org_str}"), "--scope=rrn"])
        )
        .unwrap(),
        CryptoCliCommand::RotateTenantDek {
            org_id: org,
            scope: CryptoScopeSelection::Rrn,
        }
    );
    for bad_rotate in [
        vec![],
        vec!["--org", "not-a-uuid"],
        vec!["--org", &org_str, "--scope", "invalid"],
        vec!["--org", &org_str, "--org", &org_str],
        vec!["--org", &org_str, "--unknown"],
    ] {
        assert!(
            matches!(
                parse_cli_command("rotate-tenant-dek", &args(&bad_rotate)),
                Err(AppError::Config(_))
            ),
            "rotate-tenant-dek should reject {bad_rotate:?}"
        );
    }

    assert_eq!(
        parse_cli_command("rewrap-master-kek", &[]).unwrap(),
        CryptoCliCommand::RewrapMasterKek {
            org_id: None,
            scope: CryptoScopeSelection::All,
            batch_size: DEFAULT_BATCH_SIZE,
            max_batches: CLI_DEFAULT_MAX_BATCHES_PER_ORG,
        }
    );
    assert_eq!(
        parse_cli_command(
            "rewrap-master-kek",
            &args(&[
                "--org",
                &org_str,
                "--scope",
                "mail",
                "--batch-size=15",
                "--max-batches",
                "3"
            ])
        )
        .unwrap(),
        CryptoCliCommand::RewrapMasterKek {
            org_id: Some(org),
            scope: CryptoScopeSelection::Mail,
            batch_size: 15,
            max_batches: 3,
        }
    );
    for bad_rewrap in [
        vec!["--org", "bad"],
        vec!["--scope=other"],
        vec!["--batch-size=0"],
        vec!["--max-batches=0"],
        vec!["--unknown"],
    ] {
        assert!(
            matches!(
                parse_cli_command("rewrap-master-kek", &args(&bad_rewrap)),
                Err(AppError::Config(_))
            ),
            "rewrap-master-kek should reject {bad_rewrap:?}"
        );
    }

    assert!(matches!(
        parse_cli_command("crypto-unknown", &[]).unwrap_err(),
        AppError::Config(_)
    ));
}
