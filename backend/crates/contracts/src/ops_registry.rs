// SPDX-License-Identifier: LicenseRef-Proprietary
use console_contracts::{DocumentPreamble, Fragment, NamedYaml, Operation, PathItem};

pub const EXPECTED_FRAGMENTS: usize = 1;
pub const ALL_FRAGMENTS: &[&Fragment] = &[&CONTRACT];
pub const PREAMBLE: DocumentPreamble = DocumentPreamble {
    openapi: "3.1.0",
    info: include_str!("../../ops/rest/openapi/info.yaml"),
};

macro_rules! paths {
    ($($suffix:literal => [$($method:literal => $body:expr),+ $(,)?]),+ $(,)?) => { &[$(PathItem {
        path: concat!("/api/ops/v1", $suffix),
        operations: &[$(Operation { method: $method, body: $body }),+],
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
        "/me" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__me.get.yaml")],
        "/home" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__home.get.yaml")],
        "/alerts" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__alerts.get.yaml")],
        "/alerts/{key}" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__alerts__key.get.yaml")],
        "/alerts/{key}/ack" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__alerts__key__ack.post.yaml")],
        "/silences" => [
            "get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__silences.get.yaml"),
            "post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__silences.post.yaml"),
        ],
        "/silences/{id}" => ["delete" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__silences__id.delete.yaml")],
        "/oncall" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__oncall.get.yaml")],
        "/oncall/page-test" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__oncall__page_test.post.yaml")],
        "/running" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__running.get.yaml")],
        "/running/jobs" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__running__jobs.get.yaml")],
        "/running/jobs/{name}/rerun" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__running__jobs__name__rerun.post.yaml")],
        "/sources" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__sources.get.yaml")],
        "/health" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__health.get.yaml")],
        "/incidents" => [
            "get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__incidents.get.yaml"),
            "post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__incidents.post.yaml"),
        ],
        "/incidents/{id}" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__incidents__id.get.yaml")],
        "/incidents/{id}/events" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__incidents__id__events.post.yaml")],
        "/incidents/{id}/public-draft" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__incidents__id__public_draft.post.yaml")],
        "/changes" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__changes.get.yaml")],
        "/changes/rollback" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__changes__rollback.post.yaml")],
        "/changes/canary" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__changes__canary.post.yaml")],
        "/changes/freeze" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__changes__freeze.post.yaml")],
        "/promote" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__promote.get.yaml")],
        "/promote/signoff" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__promote__signoff.post.yaml")],
        "/promote/feedback" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__promote__feedback.post.yaml")],
        "/promote/request" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__promote__request.post.yaml")],
        "/recovery" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__recovery.get.yaml")],
        "/recovery/backup" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__recovery__backup.post.yaml")],
        "/recovery/drill" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__recovery__drill.post.yaml")],
        "/actions" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__actions.get.yaml")],
        "/runbooks" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__runbooks.get.yaml")],
        "/runbooks/{path}" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__runbooks__path.get.yaml")],
        "/obligations" => [
            "get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__obligations.get.yaml"),
            "post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__obligations.post.yaml"),
        ],
        "/obligations/{id}" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__obligations__id.get.yaml")],
        "/obligations/{id}/events" => ["post" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__obligations__id__events.post.yaml")],
        "/events" => ["get" => include_str!("../../ops/rest/openapi/paths/api__ops__v1__events.get.yaml")],
    ],
    schemas: schemas![
        "AckRecord" => include_str!("../../ops/rest/openapi/schemas/AckRecord.yaml"),
        "AckRequest" => include_str!("../../ops/rest/openapi/schemas/AckRequest.yaml"),
        "AckResponse" => include_str!("../../ops/rest/openapi/schemas/AckResponse.yaml"),
        "ActionRecord" => include_str!("../../ops/rest/openapi/schemas/ActionRecord.yaml"),
        "ActionsList" => include_str!("../../ops/rest/openapi/schemas/ActionsList.yaml"),
        "AlertDetail" => include_str!("../../ops/rest/openapi/schemas/AlertDetail.yaml"),
        "AlertGroup" => include_str!("../../ops/rest/openapi/schemas/AlertGroup.yaml"),
        "AlertGroupDetail" => include_str!("../../ops/rest/openapi/schemas/AlertGroupDetail.yaml"),
        "AlertGroups" => include_str!("../../ops/rest/openapi/schemas/AlertGroups.yaml"),
        "AlertMember" => include_str!("../../ops/rest/openapi/schemas/AlertMember.yaml"),
        "AlertMessage" => include_str!("../../ops/rest/openapi/schemas/AlertMessage.yaml"),
        "AlertState" => include_str!("../../ops/rest/openapi/schemas/AlertState.yaml"),
        "BackupRequest" => include_str!("../../ops/rest/openapi/schemas/BackupRequest.yaml"),
        "Budget" => include_str!("../../ops/rest/openapi/schemas/Budget.yaml"),
        "CanaryRequest" => include_str!("../../ops/rest/openapi/schemas/CanaryRequest.yaml"),
        "Change" => include_str!("../../ops/rest/openapi/schemas/Change.yaml"),
        "ChangesView" => include_str!("../../ops/rest/openapi/schemas/ChangesView.yaml"),
        "Changing" => include_str!("../../ops/rest/openapi/schemas/Changing.yaml"),
        "CmdHandOff" => include_str!("../../ops/rest/openapi/schemas/CmdHandOff.yaml"),
        "CmdResponse" => include_str!("../../ops/rest/openapi/schemas/CmdResponse.yaml"),
        "Component" => include_str!("../../ops/rest/openapi/schemas/Component.yaml"),
        "Cost" => include_str!("../../ops/rest/openapi/schemas/Cost.yaml"),
        "Credential" => include_str!("../../ops/rest/openapi/schemas/Credential.yaml"),
        "DataSafety" => include_str!("../../ops/rest/openapi/schemas/DataSafety.yaml"),
        "DeclareIncidentRequest" => include_str!("../../ops/rest/openapi/schemas/DeclareIncidentRequest.yaml"),
        "Dora5Metrics" => include_str!("../../ops/rest/openapi/schemas/Dora5Metrics.yaml"),
        "Drift" => include_str!("../../ops/rest/openapi/schemas/Drift.yaml"),
        "DrillRequest" => include_str!("../../ops/rest/openapi/schemas/DrillRequest.yaml"),
        "Error" => include_str!("../../ops/rest/openapi/schemas/Error.yaml"),
        "Event" => include_str!("../../ops/rest/openapi/schemas/Event.yaml"),
        "Evidence" => include_str!("../../ops/rest/openapi/schemas/Evidence.yaml"),
        "EvidenceState" => include_str!("../../ops/rest/openapi/schemas/EvidenceState.yaml"),
        "FeedbackRequest" => include_str!("../../ops/rest/openapi/schemas/FeedbackRequest.yaml"),
        "FeedbackResponse" => include_str!("../../ops/rest/openapi/schemas/FeedbackResponse.yaml"),
        "FeedbackTriage" => include_str!("../../ops/rest/openapi/schemas/FeedbackTriage.yaml"),
        "FreeTierMeter" => include_str!("../../ops/rest/openapi/schemas/FreeTierMeter.yaml"),
        "FreezeRequest" => include_str!("../../ops/rest/openapi/schemas/FreezeRequest.yaml"),
        "Grant" => include_str!("../../ops/rest/openapi/schemas/Grant.yaml"),
        "Health" => include_str!("../../ops/rest/openapi/schemas/Health.yaml"),
        "HomeSnapshot" => include_str!("../../ops/rest/openapi/schemas/HomeSnapshot.yaml"),
        "Incident" => include_str!("../../ops/rest/openapi/schemas/Incident.yaml"),
        "IncidentDetail" => include_str!("../../ops/rest/openapi/schemas/IncidentDetail.yaml"),
        "IncidentEventRequest" => include_str!("../../ops/rest/openapi/schemas/IncidentEventRequest.yaml"),
        "IncidentResponse" => include_str!("../../ops/rest/openapi/schemas/IncidentResponse.yaml"),
        "IncidentSeverity" => include_str!("../../ops/rest/openapi/schemas/IncidentSeverity.yaml"),
        "IncidentState" => include_str!("../../ops/rest/openapi/schemas/IncidentState.yaml"),
        "IncidentSummary" => include_str!("../../ops/rest/openapi/schemas/IncidentSummary.yaml"),
        "IncidentTimelineEntry" => include_str!("../../ops/rest/openapi/schemas/IncidentTimelineEntry.yaml"),
        "IncidentsList" => include_str!("../../ops/rest/openapi/schemas/IncidentsList.yaml"),
        "Job" => include_str!("../../ops/rest/openapi/schemas/Job.yaml"),
        "JobState" => include_str!("../../ops/rest/openapi/schemas/JobState.yaml"),
        "Jobs" => include_str!("../../ops/rest/openapi/schemas/Jobs.yaml"),
        "LegalClock" => include_str!("../../ops/rest/openapi/schemas/LegalClock.yaml"),
        "Link" => include_str!("../../ops/rest/openapi/schemas/Link.yaml"),
        "Live" => include_str!("../../ops/rest/openapi/schemas/Live.yaml"),
        "Matcher" => include_str!("../../ops/rest/openapi/schemas/Matcher.yaml"),
        "Me" => include_str!("../../ops/rest/openapi/schemas/Me.yaml"),
        "ObligationDetail" => include_str!("../../ops/rest/openapi/schemas/ObligationDetail.yaml"),
        "ObligationEventRequest" => include_str!("../../ops/rest/openapi/schemas/ObligationEventRequest.yaml"),
        "ObligationItem" => include_str!("../../ops/rest/openapi/schemas/ObligationItem.yaml"),
        "ObligationKind" => include_str!("../../ops/rest/openapi/schemas/ObligationKind.yaml"),
        "ObligationOperator" => include_str!("../../ops/rest/openapi/schemas/ObligationOperator.yaml"),
        "ObligationRecord" => include_str!("../../ops/rest/openapi/schemas/ObligationRecord.yaml"),
        "ObligationReviewerRole" => include_str!("../../ops/rest/openapi/schemas/ObligationReviewerRole.yaml"),
        "ObligationState" => include_str!("../../ops/rest/openapi/schemas/ObligationState.yaml"),
        "ObligationWriteResponse" => include_str!("../../ops/rest/openapi/schemas/ObligationWriteResponse.yaml"),
        "ObligationsList" => include_str!("../../ops/rest/openapi/schemas/ObligationsList.yaml"),
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
        "OncallView" => include_str!("../../ops/rest/openapi/schemas/OncallView.yaml"),
        "OpenObligationRequest" => include_str!("../../ops/rest/openapi/schemas/OpenObligationRequest.yaml"),
        "PersonalDataImpact" => include_str!("../../ops/rest/openapi/schemas/PersonalDataImpact.yaml"),
        "PromoteRequest" => include_str!("../../ops/rest/openapi/schemas/PromoteRequest.yaml"),
        "PromoteView" => include_str!("../../ops/rest/openapi/schemas/PromoteView.yaml"),
        "Promotion" => include_str!("../../ops/rest/openapi/schemas/Promotion.yaml"),
        "PromotionSignoff" => include_str!("../../ops/rest/openapi/schemas/PromotionSignoff.yaml"),
        "PublicComponent" => include_str!("../../ops/rest/openapi/schemas/PublicComponent.yaml"),
        "PublicDraftRequest" => include_str!("../../ops/rest/openapi/schemas/PublicDraftRequest.yaml"),
        "PublicDraftResponse" => include_str!("../../ops/rest/openapi/schemas/PublicDraftResponse.yaml"),
        "Recovery" => include_str!("../../ops/rest/openapi/schemas/Recovery.yaml"),
        "RecoveryRepoView" => include_str!("../../ops/rest/openapi/schemas/RecoveryRepoView.yaml"),
        "RecoveryView" => include_str!("../../ops/rest/openapi/schemas/RecoveryView.yaml"),
        "RefusalCode" => include_str!("../../ops/rest/openapi/schemas/RefusalCode.yaml"),
        "Release" => include_str!("../../ops/rest/openapi/schemas/Release.yaml"),
        "RollbackRequest" => include_str!("../../ops/rest/openapi/schemas/RollbackRequest.yaml"),
        "Rollup" => include_str!("../../ops/rest/openapi/schemas/Rollup.yaml"),
        "Rule" => include_str!("../../ops/rest/openapi/schemas/Rule.yaml"),
        "RunbookAnchor" => include_str!("../../ops/rest/openapi/schemas/RunbookAnchor.yaml"),
        "RunbookDoc" => include_str!("../../ops/rest/openapi/schemas/RunbookDoc.yaml"),
        "RunbookDocMeta" => include_str!("../../ops/rest/openapi/schemas/RunbookDocMeta.yaml"),
        "RunbookDocView" => include_str!("../../ops/rest/openapi/schemas/RunbookDocView.yaml"),
        "RunbookListView" => include_str!("../../ops/rest/openapi/schemas/RunbookListView.yaml"),
        "Running" => include_str!("../../ops/rest/openapi/schemas/Running.yaml"),
        "ServiceHealthView" => include_str!("../../ops/rest/openapi/schemas/ServiceHealthView.yaml"),
        "Severity" => include_str!("../../ops/rest/openapi/schemas/Severity.yaml"),
        "SignoffRequest" => include_str!("../../ops/rest/openapi/schemas/SignoffRequest.yaml"),
        "SignoffResponse" => include_str!("../../ops/rest/openapi/schemas/SignoffResponse.yaml"),
        "Silence" => include_str!("../../ops/rest/openapi/schemas/Silence.yaml"),
        "SilenceCreateRequest" => include_str!("../../ops/rest/openapi/schemas/SilenceCreateRequest.yaml"),
        "SilenceCreateResponse" => include_str!("../../ops/rest/openapi/schemas/SilenceCreateResponse.yaml"),
        "SilenceDeleteResponse" => include_str!("../../ops/rest/openapi/schemas/SilenceDeleteResponse.yaml"),
        "SilenceMatcherInput" => include_str!("../../ops/rest/openapi/schemas/SilenceMatcherInput.yaml"),
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
    assert_eq!(CONTRACT.paths.len(), 36);
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
