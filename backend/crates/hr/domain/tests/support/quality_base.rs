// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{
    fs,
    process::{Command, Output},
};

pub(super) fn quality_ref(git: &impl Fn(&[&str]) -> Output, explicit: Option<String>) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit;
    }
    let upstream = git(&["rev-parse", "--abbrev-ref", "dev@{upstream}"]);
    if upstream.status.success() {
        return String::from_utf8(upstream.stdout).unwrap().trim().into();
    }
    let base = if git(&["config", "--get", "remote.origin.url"])
        .status
        .success()
        && git(&[
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/dev",
        ])
        .status
        .success()
    {
        "origin/dev"
    } else {
        "dev"
    };
    eprintln!(
        "quality base: {base} (dev has no upstream; set one with git branch --set-upstream-to=<remote>/dev dev, or QUALITY_BASE=<ref>)"
    );
    base.into()
}

#[test]
fn quality_base_prefers_upstream_and_ignores_orphaned_origin() {
    let root = std::env::temp_dir().join(format!("catalogue-refs-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let mut command = Command::new("git");
        for (key, _) in
            std::env::vars_os().filter(|(key, _)| key.to_string_lossy().starts_with("GIT_"))
        {
            command.env_remove(key);
        }
        command
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap()
    };
    let run = |args: &[&str]| {
        let output = git(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["init", "-b", "dev"]);
    run(&["commit", "--allow-empty", "-m", "test: seed quality refs"]);
    run(&["update-ref", "refs/remotes/public/dev", "HEAD"]);
    assert_eq!(quality_ref(&git, None), "dev");
    run(&["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    assert_eq!(quality_ref(&git, None), "dev");
    run(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/console.git",
    ]);
    assert_eq!(quality_ref(&git, None), "origin/dev");
    run(&[
        "remote",
        "add",
        "team",
        "https://example.invalid/console.git",
    ]);
    run(&["update-ref", "refs/remotes/team/trunk", "HEAD"]);
    run(&["branch", "--set-upstream-to=team/trunk", "dev"]);
    assert_eq!(quality_ref(&git, None), "team/trunk");
    assert_eq!(quality_ref(&git, Some(String::new())), "team/trunk");
    assert_eq!(quality_ref(&git, Some("review-base".into())), "review-base");
    run(&["update-ref", "-d", "refs/remotes/team/trunk"]);
    assert_eq!(quality_ref(&git, None), "origin/dev");
    run(&["remote", "remove", "origin"]);
    assert_eq!(quality_ref(&git, None), "dev");
    fs::remove_dir_all(root).unwrap();
}
