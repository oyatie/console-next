// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::{Observed, UtcTimestamp};

pub const IN_TOTO_STATEMENT_TYPE: &str = "https://in-toto.io/Statement/v1";
pub const CONSOLE_GATES_PREDICATE_TYPE: &str =
    "https://cosskorea.com/attestations/console-gates/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CmdHandOff {
    pub action_id: String,
    pub kind: String,
    pub command: String,
    pub target: String,
    pub consequence: String,
    pub expected_result: String,
    pub verify_step: String,
    pub operator: String,
    pub at: UtcTimestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateSubject {
    #[serde(default)]
    pub name: Option<String>,
    pub digest: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateResultEntry {
    pub name: String,
    pub result: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateRunner {
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatePredicate {
    pub inputs: BTreeMap<String, Value>,
    pub gates: Vec<GateResultEntry>,
    pub runner: GateRunner,
    #[serde(default)]
    pub approver: Option<Value>,
    pub bake: String,
    #[serde(default)]
    pub trunk_admission: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateStatement {
    #[serde(rename = "_type")]
    pub statement_type: String,
    #[serde(rename = "predicateType")]
    pub predicate_type: String,
    pub subject: Vec<GateSubject>,
    pub predicate: GatePredicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateParseError(pub String);

impl std::fmt::Display for GateParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GateParseError {}

pub fn is_valid_sha256_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

impl GateStatement {
    pub fn release_image(&self, digest: &str) -> Option<String> {
        if !is_valid_sha256_digest(digest) {
            return None;
        }
        let hex = digest.strip_prefix("sha256:")?;
        let mut matching = self
            .subject
            .iter()
            .filter(|s| s.digest.get("sha256").map(String::as_str) == Some(hex));
        let name = matching.next()?.name.as_deref()?;
        let (host, repo) = name.split_once('/')?;
        if matching.next().is_some()
            || !host
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !(host.contains('.') || host.contains(':') || host == "localhost")
            || repo.is_empty()
            || !host
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".:-".contains(&c))
            || !repo.split('/').all(|part| {
                !part.is_empty()
                    && part.as_bytes()[0].is_ascii_alphanumeric()
                    && part.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c)
                    })
            })
        {
            return None;
        }
        Some(format!("{name}@{digest}"))
    }

    pub fn promotion_gates_pass(&self) -> bool {
        const COMMON: [&str; 5] = ["code-gates", "api-compat", "sbom", "scan", "smoke"];
        let gates = &self.predicate.gates;
        let mut names = std::collections::BTreeSet::new();
        if !gates.iter().all(|g| {
            names.insert(g.name.as_str())
                && (g.result == "pass" || (g.name == "repro" && g.result == "skip"))
        }) {
            return false;
        }
        // The host also signs candidate and rehearsal gates; its weekly reproducibility check may skip.
        COMMON.iter().all(|name| names.contains(name))
            && if self.predicate.inputs.contains_key("infra") {
                names.contains("candidate") && names.contains("rehearse")
            } else {
                names.len() == COMMON.len()
            }
    }
}

pub fn parse_gate_statement(
    raw: &str,
    expected_digest: Option<&str>,
) -> Result<GateStatement, GateParseError> {
    let stmt: GateStatement = serde_json::from_str(raw)
        .map_err(|e| GateParseError(format!("invalid gates JSON: {e}")))?;
    if stmt.statement_type != IN_TOTO_STATEMENT_TYPE {
        return Err(GateParseError("unexpected in-toto _type".to_owned()));
    }
    if stmt.predicate_type != CONSOLE_GATES_PREDICATE_TYPE {
        return Err(GateParseError("unexpected predicateType".to_owned()));
    }
    if stmt.subject.is_empty() || stmt.predicate.gates.is_empty() {
        return Err(GateParseError(
            "gate statement must have subject and gates".to_owned(),
        ));
    }
    if !matches!(stmt.predicate.bake.as_str(), "normal" | "long") {
        return Err(GateParseError(
            "predicate.bake must be normal or long".to_owned(),
        ));
    }
    if let Some(expected) = expected_digest {
        let Some(hex64) = expected.strip_prefix("sha256:") else {
            return Err(GateParseError("invalid expected sha256 digest".to_owned()));
        };
        if !is_valid_sha256_digest(expected) {
            return Err(GateParseError("invalid expected sha256 digest".to_owned()));
        }
        let matches_subject = stmt
            .subject
            .iter()
            .any(|sub| sub.digest.get("sha256").map(String::as_str) == Some(hex64));
        if !matches_subject {
            return Err(GateParseError(
                "subject sha256 digest does not match directory".to_owned(),
            ));
        }
    }
    Ok(stmt)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSample {
    pub digest: String,
    pub released_at: OffsetDateTime,
    pub commit_at: Option<OffsetDateTime>,
    pub restored_at: Option<OffsetDateTime>,
    pub failed: bool,
    pub rolled_back: bool,
    pub rework: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dora5Metrics {
    pub deployment_frequency: Observed<f64>,
    pub lead_time_s: Observed<f64>,
    pub change_failure_rate: Observed<f64>,
    pub mttr_s: Observed<f64>,
    pub rework_rate: Observed<f64>,
    pub n: usize,
}

pub fn compute_dora5(
    records: &[ReleaseSample],
    source: &str,
    observed_at: Option<OffsetDateTime>,
    now: OffsetDateTime,
    interval_s: NonZeroU64,
) -> Dora5Metrics {
    if records.is_empty() {
        let unknown = || Observed::unknown(source.to_owned(), "not instrumented".to_owned());
        return Dora5Metrics {
            deployment_frequency: unknown(),
            lead_time_s: unknown(),
            change_failure_rate: unknown(),
            mttr_s: unknown(),
            rework_rate: unknown(),
            n: 0,
        };
    }

    let mut seen = BTreeSet::new();
    let mut distinct: Vec<&ReleaseSample> = Vec::new();
    for r in records {
        if seen.insert(r.digest.as_str()) {
            distinct.push(r);
        }
    }
    let n = distinct.len();
    let min_at = distinct.iter().map(|r| r.released_at).min().unwrap_or(now);
    let span_days = ((now - min_at).whole_seconds().max(86_400) as f64) / 86_400.0;
    let freq = (n as f64) / span_days;

    let lead_samples: Vec<f64> = distinct
        .iter()
        .filter_map(|r| {
            r.commit_at
                .map(|c| (r.released_at - c).whole_seconds().max(0) as f64)
        })
        .collect();
    let lead_avg = (!lead_samples.is_empty())
        .then(|| lead_samples.iter().sum::<f64>() / lead_samples.len() as f64);

    let failed_n = distinct
        .iter()
        .filter(|r| r.failed || r.rolled_back)
        .count();
    let cfr = (failed_n as f64) / (n as f64);

    let mttr_samples: Vec<f64> = distinct
        .iter()
        .filter(|r| r.failed || r.rolled_back)
        .filter_map(|r| {
            r.restored_at
                .map(|restored| (restored - r.released_at).whole_seconds().max(0) as f64)
        })
        .collect();
    let mttr_avg = (!mttr_samples.is_empty())
        .then(|| mttr_samples.iter().sum::<f64>() / mttr_samples.len() as f64);

    let rework_n = distinct.iter().filter(|r| r.rework).count();
    let rework_rate = (rework_n as f64) / (n as f64);

    let obs_at = observed_at.unwrap_or(now);
    let observe_opt = |val: Option<f64>, unit: &str| match val {
        Some(v) => Observed::current(
            v,
            Some(unit.to_owned()),
            source.to_owned(),
            obs_at,
            now,
            interval_s,
        ),
        None => Observed::unknown(source.to_owned(), "not instrumented".to_owned()),
    };

    Dora5Metrics {
        deployment_frequency: observe_opt(Some(freq), "/day"),
        lead_time_s: observe_opt(lead_avg, "s"),
        change_failure_rate: observe_opt(Some(cfr), "ratio"),
        mttr_s: observe_opt(mttr_avg, "s"),
        rework_rate: observe_opt(Some(rework_rate), "ratio"),
        n,
    }
}
