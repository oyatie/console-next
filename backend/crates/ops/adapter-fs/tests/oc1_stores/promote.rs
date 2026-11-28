// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn promotion_uses_complete_gates_and_the_current_spool_verdicts() -> TestResult {
    use console_ops_adapter_fs::SpoolSet;
    use console_ops_application::domain::ladders::Promotion;
    use console_ops_application::promote::PromoteService;
    use console_ops_application::snapshot::SourceKind;
    use console_ops_application::sources_status::SourceSlot;
    use console_ops_application::victoriametrics::{
        InstantSample, QUERY_FREEZE, QUERY_PREVIEW_DIGEST_INFO, QUERY_PREVIEW_RUNNING,
        VictoriaMetricsSnapshot,
    };
    use std::num::NonZeroU64;

    let tmp = Temp::new();
    let hex = "a".repeat(64);
    let digest = format!("sha256:{hex}");
    let now = OffsetDateTime::UNIX_EPOCH;
    let ctx = |person: &str| Context {
        at: now,
        operator: Operator {
            person: person.into(),
            method: "access-jwt".into(),
        },
        support_ref: "sup-1".into(),
    };
    let gate_dir = tmp.0.join(&digest);
    fs::create_dir(&gate_dir)?;
    let policy: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../deploy/gates.json"))?;
    let passing: Vec<_> = policy["checks"]
        .as_object()
        .ok_or("missing gate policy")?
        .keys()
        .map(|name| json!({"name":name, "result":"pass"}))
        .collect();
    let set_gates = |gates: &[serde_json::Value]| {
        fs::write(gate_dir.join("gates.json"),
        json!({
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
            "subject": [{"digest": {"sha256": hex}}],
            "predicate": {"inputs": {}, "gates": gates, "runner": {"kind": "gha"}, "bake": "normal"}
        }).to_string())
    };

    let spools = SpoolSet::open_resilient(&tmp.0);
    let releases = FsReleasesStore::new(&tmp.0);
    let service = PromoteService {
        releases: Some(&releases),
        promotions: &*spools.promotions,
        feedback: &*spools.feedback,
        actions: &*spools.actions,
    };
    let mut vm = SourceSlot::new(
        "vm",
        SourceKind::VictoriaMetrics,
        "vm".into(),
        NonZeroU64::MIN,
    );
    let sample = InstantSample {
        metric: [("digest".into(), digest.clone())].into(),
        timestamp_s: 0.0,
        value: 1.0,
    };
    vm.begin_read(now);
    vm.finish_ok(VictoriaMetricsSnapshot {
        series: [
            (QUERY_PREVIEW_DIGEST_INFO.into(), vec![sample.clone()]),
            (
                QUERY_FREEZE.into(),
                vec![InstantSample {
                    value: 0.0,
                    ..sample.clone()
                }],
            ),
            (QUERY_PREVIEW_RUNNING.into(), vec![sample]),
        ]
        .into(),
        targets: vec![],
    });
    let state = || {
        service
            .build_view(&vm, now)
            .map(|v| v.state.value().cloned())
            .map_err(|e| format!("{e:?}"))
    };
    let sign = |operator, verdict| {
        service
            .signoff(&digest, verdict, "reviewed", &ctx(operator))
            .map_err(|e| format!("{e:?}"))
    };
    let feedback = |disposition| {
        service
            .triage_feedback(
                "feedback-1",
                &digest,
                "P1",
                disposition,
                "triage",
                &ctx("op-a"),
            )
            .map_err(|e| format!("{e:?}"))
    };

    set_gates(&passing)?;
    assert_eq!(state()?, Some(Promotion::Watching));
    sign("op-a", "ready")?;
    assert_eq!(state()?, Some(Promotion::Ready));

    let mut failed = passing.clone();
    failed[0]["result"] = json!("fail");
    set_gates(&failed)?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    set_gates(&passing[1..])?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    let mut duplicate = passing.clone();
    duplicate[0] = passing[1].clone();
    set_gates(&duplicate)?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    set_gates(&passing)?;

    sign("op-a", "blocked")?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    sign("op-b", "ready")?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    sign("op-a", "ready")?;
    assert_eq!(state()?, Some(Promotion::Ready));

    feedback("open")?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    feedback("resolved")?;
    assert_eq!(state()?, Some(Promotion::Ready));
    feedback("open")?;
    assert_eq!(state()?, Some(Promotion::Blocked));
    Ok(())
}
