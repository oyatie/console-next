// SPDX-License-Identifier: LicenseRef-Proprietary
use console_contracts::{DocumentPreamble, Fragment, NamedYaml, Operation, PathItem};

pub const EXPECTED_FRAGMENTS: usize = 1;
pub const ALL_FRAGMENTS: &[&Fragment] = &[&CONTRACT];
pub const PREAMBLE: DocumentPreamble = DocumentPreamble {
    openapi: "3.1.0",
    info: include_str!("../../ops/rest/openapi/info.yaml"),
};

macro_rules! paths {
    ($($suffix:literal => $body:expr),+ $(,)?) => { &[$(PathItem {
        path: concat!("/api/ops/v1", $suffix),
        operations: &[Operation { method: "get", body: $body }],
    }),+] };
}
macro_rules! schemas {
    ($($name:literal => $body:expr),+ $(,)?) => { &[$(NamedYaml {
        name: $name,
        body: $body,
    }),+] };
}

pub const CONTRACT: Fragment = Fragment {
    source: "console-ops-rest",
    paths: paths![
        "/me" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__me.get.yaml"),
        "/home" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__home.get.yaml"),
        "/alerts" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__alerts.get.yaml"),
        "/alerts/{key}" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__alerts__key.get.yaml"),
        "/silences" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__silences.get.yaml"),
        "/running" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__running.get.yaml"),
        "/running/jobs" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__running__jobs.get.yaml"),
        "/sources" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__sources.get.yaml"),
        "/events" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__events.get.yaml"),
    ],
    schemas: schemas![
        "AlertDetail" => include_str!("../../ops/rest/openapi/schemas/AlertDetail.yaml"),
        "AlertGroup" => include_str!("../../ops/rest/openapi/schemas/AlertGroup.yaml"),
        "AlertGroupDetail" => include_str!("../../ops/rest/openapi/schemas/AlertGroupDetail.yaml"),
        "AlertGroups" => include_str!("../../ops/rest/openapi/schemas/AlertGroups.yaml"),
        "AlertMember" => include_str!("../../ops/rest/openapi/schemas/AlertMember.yaml"),
        "AlertMessage" => include_str!("../../ops/rest/openapi/schemas/AlertMessage.yaml"),
        "AlertState" => include_str!("../../ops/rest/openapi/schemas/AlertState.yaml"),
        "Budget" => include_str!("../../ops/rest/openapi/schemas/Budget.yaml"),
        "Change" => include_str!("../../ops/rest/openapi/schemas/Change.yaml"),
        "Changing" => include_str!("../../ops/rest/openapi/schemas/Changing.yaml"),
        "Component" => include_str!("../../ops/rest/openapi/schemas/Component.yaml"),
        "Cost" => include_str!("../../ops/rest/openapi/schemas/Cost.yaml"),
        "Credential" => include_str!("../../ops/rest/openapi/schemas/Credential.yaml"),
        "DataSafety" => include_str!("../../ops/rest/openapi/schemas/DataSafety.yaml"),
        "Drift" => include_str!("../../ops/rest/openapi/schemas/Drift.yaml"),
        "Error" => include_str!("../../ops/rest/openapi/schemas/Error.yaml"),
        "Event" => include_str!("../../ops/rest/openapi/schemas/Event.yaml"),
        "Evidence" => include_str!("../../ops/rest/openapi/schemas/Evidence.yaml"),
        "EvidenceState" => include_str!("../../ops/rest/openapi/schemas/EvidenceState.yaml"),
        "FreeTierMeter" => include_str!("../../ops/rest/openapi/schemas/FreeTierMeter.yaml"),
        "Grant" => include_str!("../../ops/rest/openapi/schemas/Grant.yaml"),
        "Health" => include_str!("../../ops/rest/openapi/schemas/Health.yaml"),
        "HomeSnapshot" => include_str!("../../ops/rest/openapi/schemas/HomeSnapshot.yaml"),
        "Incident" => include_str!("../../ops/rest/openapi/schemas/Incident.yaml"),
        "IncidentSeverity" => include_str!("../../ops/rest/openapi/schemas/IncidentSeverity.yaml"),
        "Job" => include_str!("../../ops/rest/openapi/schemas/Job.yaml"),
        "JobState" => include_str!("../../ops/rest/openapi/schemas/JobState.yaml"),
        "Jobs" => include_str!("../../ops/rest/openapi/schemas/Jobs.yaml"),
        "Link" => include_str!("../../ops/rest/openapi/schemas/Link.yaml"),
        "Live" => include_str!("../../ops/rest/openapi/schemas/Live.yaml"),
        "Matcher" => include_str!("../../ops/rest/openapi/schemas/Matcher.yaml"),
        "Me" => include_str!("../../ops/rest/openapi/schemas/Me.yaml"),
        "Observation" => include_str!("../../ops/rest/openapi/schemas/Observation.yaml"),
        "ObservedAlertState" => include_str!("../../ops/rest/openapi/schemas/ObservedAlertState.yaml"),
        "ObservedBoolean" => include_str!("../../ops/rest/openapi/schemas/ObservedBoolean.yaml"),
        "ObservedCount" => include_str!("../../ops/rest/openapi/schemas/ObservedCount.yaml"),
        "ObservedDrift" => include_str!("../../ops/rest/openapi/schemas/ObservedDrift.yaml"),
        "ObservedHealth" => include_str!("../../ops/rest/openapi/schemas/ObservedHealth.yaml"),
        "ObservedJobState" => include_str!("../../ops/rest/openapi/schemas/ObservedJobState.yaml"),
        "ObservedNumber" => include_str!("../../ops/rest/openapi/schemas/ObservedNumber.yaml"),
        "ObservedSeverity" => include_str!("../../ops/rest/openapi/schemas/ObservedSeverity.yaml"),
        "ObservedState" => include_str!("../../ops/rest/openapi/schemas/ObservedState.yaml"),
        "ObservedText" => include_str!("../../ops/rest/openapi/schemas/ObservedText.yaml"),
        "ObservedTimestamp" => include_str!("../../ops/rest/openapi/schemas/ObservedTimestamp.yaml"),
        "Promotion" => include_str!("../../ops/rest/openapi/schemas/Promotion.yaml"),
        "PublicComponent" => include_str!("../../ops/rest/openapi/schemas/PublicComponent.yaml"),
        "Recovery" => include_str!("../../ops/rest/openapi/schemas/Recovery.yaml"),
        "RefusalCode" => include_str!("../../ops/rest/openapi/schemas/RefusalCode.yaml"),
        "Release" => include_str!("../../ops/rest/openapi/schemas/Release.yaml"),
        "Rollup" => include_str!("../../ops/rest/openapi/schemas/Rollup.yaml"),
        "Rule" => include_str!("../../ops/rest/openapi/schemas/Rule.yaml"),
        "Running" => include_str!("../../ops/rest/openapi/schemas/Running.yaml"),
        "Severity" => include_str!("../../ops/rest/openapi/schemas/Severity.yaml"),
        "Silence" => include_str!("../../ops/rest/openapi/schemas/Silence.yaml"),
        "Silences" => include_str!("../../ops/rest/openapi/schemas/Silences.yaml"),
        "Source" => include_str!("../../ops/rest/openapi/schemas/Source.yaml"),
        "Sources" => include_str!("../../ops/rest/openapi/schemas/Sources.yaml"),
        "Text" => include_str!("../../ops/rest/openapi/schemas/Text.yaml"),
        "Timestamp" => include_str!("../../ops/rest/openapi/schemas/Timestamp.yaml"),
        "TwoPerson" => include_str!("../../ops/rest/openapi/schemas/TwoPerson.yaml"),
        "ValueVsThreshold" => include_str!("../../ops/rest/openapi/schemas/ValueVsThreshold.yaml"),
        "Verdict" => include_str!("../../ops/rest/openapi/schemas/Verdict.yaml"),
        "WorkItem" => include_str!("../../ops/rest/openapi/schemas/WorkItem.yaml"),
        "WorkKind" => include_str!("../../ops/rest/openapi/schemas/WorkKind.yaml"),
    ],
    parameters: &[],
    responses: &[
        NamedYaml {
            name: "Unauthorized",
            body: include_str!("../../ops/rest/openapi/responses/Unauthorized.yaml"),
        },
        NamedYaml {
            name: "Forbidden",
            body: include_str!("../../ops/rest/openapi/responses/Forbidden.yaml"),
        },
    ],
    security_schemes: &[NamedYaml {
        name: "accessJwt",
        body: "type: apiKey\nin: header\nname: Cf-Access-Jwt-Assertion\n",
    }],
    external_schemas: &[],
};

pub fn document() -> Result<String, String> {
    if ALL_FRAGMENTS.len() != EXPECTED_FRAGMENTS {
        return Err(format!(
            "expected {EXPECTED_FRAGMENTS} ops fragments, found {}",
            ALL_FRAGMENTS.len()
        ));
    }
    console_contracts::compose_document(ALL_FRAGMENTS, &PREAMBLE).map_err(|err| err.to_string())
}

#[cfg(test)]
#[test]
#[allow(clippy::unwrap_used)]
fn ops_document_is_complete_current_and_separate_from_tenant_routes() {
    let ops = document().unwrap();
    assert_eq!(CONTRACT.paths.len(), 9);
    assert_eq!(ops, include_str!("../../../openapi/ops.yaml"));
    assert!(ops.contains("/api/ops/v1/home:"));
    assert!(!ops.contains("/api/v1/"));
    let tenant = console_contracts::compose_document(
        crate::gen_registry::ALL_FRAGMENTS,
        &crate::gen_registry::PREAMBLE,
    )
    .unwrap();
    assert!(!tenant.contains("/api/ops/"));
}
