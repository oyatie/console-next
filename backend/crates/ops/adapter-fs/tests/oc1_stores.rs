// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;

use console_ops_adapter_fs::{FsHostStateStore, FsReleasesStore, FsRunbookStore};
use console_ops_application::changes::{HostStateStore, ReleasesStore};
use console_ops_application::runbooks::{RunbookError, RunbookStore};
use serde_json::json;

mod support;
use support::Temp;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn fs_releases_store_reads_valid_gates_handles_missing_and_rejects_symlinks() -> TestResult {
    let tmp = Temp::new();
    assert!(!tmp.record(1).exists());
    let hex_ok = "a".repeat(64);
    let digest_ok = format!("sha256:{hex_ok}");
    let hex_missing = "b".repeat(64);
    let digest_missing = format!("sha256:{hex_missing}");

    fs::create_dir_all(tmp.0.join(&digest_ok))?;
    fs::create_dir_all(tmp.0.join(&digest_missing))?;
    fs::create_dir_all(tmp.0.join("not-a-digest"))?;

    let gates = json!({
        "_type": "https://in-toto.io/Statement/v1",
        "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
        "subject": [{"digest": {"sha256": hex_ok}}],
        "predicate": {
            "inputs": {"backend": "1234"},
            "gates": [{"name": "smoke", "result": "pass"}],
            "runner": {"kind": "gha", "url": null},
            "approver": null,
            "bake": "normal"
        }
    });
    fs::write(tmp.0.join(&digest_ok).join("gates.json"), gates.to_string())?;

    let store = FsReleasesStore::new(&tmp.0);
    let list = store.list_releases()?;
    assert_eq!(list.len(), 2);
    assert!(list[0].gates.is_some());
    assert!(list[1].gates.is_none());
    assert_eq!(list[1].missing_reason.as_deref(), Some("gate missing"));

    assert!(store.get_gates(&digest_ok)?.is_some());
    assert!(store.get_gates(&digest_missing)?.is_none());
    assert!(store.get_gates("../etc").is_err());

    #[cfg(unix)]
    {
        let hex_sym = "c".repeat(64);
        let digest_sym = format!("sha256:{hex_sym}");
        let outside = tmp.0.join("outside.json");
        fs::write(&outside, gates.to_string())?;
        fs::create_dir_all(tmp.0.join(&digest_sym))?;
        std::os::unix::fs::symlink(&outside, tmp.0.join(&digest_sym).join("gates.json"))?;
        assert!(store.get_gates(&digest_sym).is_err());
    }
    Ok(())
}

#[test]
fn fs_runbook_store_enforces_allowlist_anchor_extraction_and_symlink_guards() -> TestResult {
    let tmp = Temp::new();
    let rb_dir = tmp.0.join("runbooks");
    fs::create_dir_all(rb_dir.join("docs/patches"))?;
    fs::write(rb_dir.join("RUNBOOK.md"), "# Ops Runbook\n## Restart\n")?;
    fs::write(
        rb_dir.join("docs/production-hygiene.md"),
        "# Hygiene\n<a id=\"report-and-capacity-response\"></a>\n",
    )?;
    fs::write(rb_dir.join("docs/patches/secret.md"), "# Must be excluded")?;
    fs::write(rb_dir.join("docs/script-ledger.tsv"), "excluded")?;
    fs::write(rb_dir.join("docs/ops-backlog.md"), "excluded")?;

    let store = FsRunbookStore::new(&tmp.0);
    let docs = store.list_docs().map_err(|e| format!("{e:?}"))?;
    let paths: Vec<&str> = docs.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, vec!["RUNBOOK.md", "docs/production-hygiene.md"]);

    let doc = store.read_doc("RUNBOOK.md").map_err(|e| format!("{e:?}"))?;
    assert_eq!(doc.anchors.len(), 2);
    assert_eq!(doc.anchors[1].slug, "restart");

    assert_eq!(
        store.read_doc("../etc/passwd"),
        Err(RunbookError::InvalidPath)
    );
    assert_eq!(
        store.read_doc("docs/patches/secret.md"),
        Err(RunbookError::InvalidPath)
    );
    assert_eq!(
        store.read_doc("docs/missing.md"),
        Err(RunbookError::NotFound)
    );

    #[cfg(unix)]
    {
        let outside = tmp.0.join("outside.md");
        fs::write(&outside, "# Secret")?;
        std::os::unix::fs::symlink(&outside, rb_dir.join("docs/link.md"))?;
        assert_eq!(
            store.read_doc("docs/link.md"),
            Err(RunbookError::InvalidPath)
        );
    }
    Ok(())
}

#[test]
fn fs_host_state_store_parses_history_and_returns_none_when_unmounted() -> TestResult {
    let tmp = Temp::new();
    let unmounted = FsHostStateStore::new(tmp.0.join("missing-state"));
    assert!(unmounted.read_deploy_history().is_none());
    assert!(unmounted.read_config_history().is_none());
    assert!(unmounted.read_rollout().is_none());
    assert!(unmounted.read_desired().is_none());
    assert!(unmounted.read_completed_requests().is_none());

    let digest = format!("sha256:{}", "a".repeat(64));
    fs::write(
        tmp.0.join("deploy-history.log"),
        format!("20261120T000000Z ok from=none to={digest} deploy ok\n"),
    )?;
    fs::write(
        tmp.0.join("config-history.log"),
        "20261120T000500Z ok sha=0123456789abcdef0123456789abcdef01234567 applied\n",
    )?;
    fs::write(tmp.0.join("rollout.json"), r#"{"step":"canary"}"#)?;
    fs::write(tmp.0.join("desired.json"), r#"{"freeze":false}"#)?;
    fs::write(tmp.0.join("requests.done"), "req-1\nreq-2\n")?;

    let store = FsHostStateStore::new(&tmp.0);
    let deploys = store.read_deploy_history().ok_or("deploy history")?;
    assert_eq!(deploys.len(), 1);
    assert_eq!(deploys[0].to_digest.as_deref(), Some(digest.as_str()));
    let configs = store.read_config_history().ok_or("config history")?;
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].sha, "0123456789abcdef0123456789abcdef01234567");
    assert!(store.read_rollout().is_some());
    assert!(store.read_desired().is_some());
    assert_eq!(
        store.read_completed_requests(),
        Some(vec!["req-1".to_owned(), "req-2".to_owned()])
    );
    Ok(())
}
