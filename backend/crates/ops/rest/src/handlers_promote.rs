// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::events::OpsEvent;
use console_ops_application::obligations::Error as SpoolError;
use console_ops_application::promote::{
    FeedbackStore, FeedbackTriage, PromoteService, PromoteView, PromotionSignoff, PromotionStore,
};
use console_ops_domain::Observed;
use console_ops_domain::changes::CmdHandOff;
use serde::{Deserialize, Serialize};

use crate::error::OpsApiError;
use crate::error_ops::{from_promote_error, from_spool_error};
use crate::handlers_common::{
    NoopActionStore, no_store_json, no_store_status_json, op_context, parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct CmdResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    action: CmdHandOff,
}

#[derive(Serialize)]
struct SignoffResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    signoff: PromotionSignoff,
}

#[derive(Serialize)]
struct FeedbackResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    feedback: FeedbackTriage,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignoffRequest {
    digest: String,
    verdict: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedbackRequest {
    feedback_id: String,
    digest: String,
    severity: String,
    disposition: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromoteRequest {
    digest: String,
    bake: String,
}

struct DummyPromotionStore;
impl PromotionStore for DummyPromotionStore {
    fn list_signoffs(&self) -> Result<Vec<PromotionSignoff>, SpoolError> {
        Ok(Vec::new())
    }
    fn record_signoff(
        &self,
        _digest: &str,
        _verdict: &str,
        _note: &str,
        _context: &console_ops_application::obligations::Context,
    ) -> Result<PromotionSignoff, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

struct DummyFeedbackStore;
impl FeedbackStore for DummyFeedbackStore {
    fn list_feedback(&self) -> Result<Vec<FeedbackTriage>, SpoolError> {
        Ok(Vec::new())
    }
    fn record_triage(
        &self,
        _feedback_id: &str,
        _digest: &str,
        _severity: &str,
        _disposition: &str,
        _note: &str,
        _context: &console_ops_application::obligations::Context,
    ) -> Result<FeedbackTriage, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

pub async fn get_promote(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/promote";
    state.authorize(&headers, "read.running", ROUTE)?;
    let sref = (state.support_ref)();
    state.refresh_vm_slot((state.clock)()).await;
    let now = (state.clock)();
    let vm_slot = state.vm_slot.read().await.clone();
    let noop_actions = NoopActionStore;
    let dummy_promo = DummyPromotionStore;
    let dummy_fb = DummyFeedbackStore;
    if state.promotions.is_none() || state.feedback.is_none() {
        return Ok(no_store_json(PromoteView {
            evaluated_at: now,
            candidate_digest: Observed::unknown(
                "promotions".to_owned(),
                "records unreadable".to_owned(),
            ),
            state: Observed::unknown("promotions".to_owned(), "records unreadable".to_owned()),
            signoffs: Vec::new(),
            feedback: Vec::new(),
        }));
    }
    let svc = PromoteService {
        releases: state.releases.as_deref(),
        promotions: state.promotions.as_deref().unwrap_or(&dummy_promo),
        feedback: state.feedback.as_deref().unwrap_or(&dummy_fb),
        actions: state.actions.as_deref().unwrap_or(&noop_actions),
    };
    let view = svc
        .build_view(&vm_slot, now)
        .map_err(|e| from_promote_error(e, sref, ROUTE))?;
    Ok(no_store_json(view))
}

pub async fn signoff_promote(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/promote/signoff";
    let op = state.authorize(&headers, "promotion.signoff", ROUTE)?;
    let sref = (state.support_ref)();
    let req: SignoffRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let promotions = state
        .promotions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let noop_actions = NoopActionStore;
    let dummy_fb = DummyFeedbackStore;
    let svc = PromoteService {
        releases: state.releases.as_deref(),
        promotions,
        feedback: state.feedback.as_deref().unwrap_or(&dummy_fb),
        actions: state.actions.as_deref().unwrap_or(&noop_actions),
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let signoff = svc
        .signoff(&req.digest, &req.verdict, &req.note, &ctx)
        .map_err(|e| from_promote_error(e, sref, ROUTE))?;
    state
        .emit_events(vec![OpsEvent::PromotionChanged {
            id: 0,
            evaluated_at: now,
            digest: signoff.digest.clone(),
        }])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        SignoffResponse {
            evaluated_at: now,
            signoff,
        },
    ))
}

pub async fn triage_feedback(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/promote/feedback";
    let op = state.authorize(&headers, "feedback.triage", ROUTE)?;
    let sref = (state.support_ref)();
    let req: FeedbackRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let feedback = state
        .feedback
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let noop_actions = NoopActionStore;
    let dummy_promo = DummyPromotionStore;
    let svc = PromoteService {
        releases: state.releases.as_deref(),
        promotions: state.promotions.as_deref().unwrap_or(&dummy_promo),
        feedback,
        actions: state.actions.as_deref().unwrap_or(&noop_actions),
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let record = svc
        .triage_feedback(
            &req.feedback_id,
            &req.digest,
            &req.severity,
            &req.disposition,
            &req.note,
            &ctx,
        )
        .map_err(|e| from_promote_error(e, sref, ROUTE))?;
    state
        .emit_events(vec![OpsEvent::PromotionChanged {
            id: 0,
            evaluated_at: now,
            digest: record.digest.clone(),
        }])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        FeedbackResponse {
            evaluated_at: now,
            feedback: record,
        },
    ))
}

pub async fn request_promote(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/promote/request";
    let op = state.authorize(&headers, "change.request.promote", ROUTE)?;
    let sref = (state.support_ref)();
    let req: PromoteRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let (Some(promotions), Some(feedback)) =
        (state.promotions.as_deref(), state.feedback.as_deref())
    else {
        return Err(from_promote_error(
            console_ops_application::promote::PromoteError::EvidenceUnavailable,
            sref,
            ROUTE,
        ));
    };
    let svc = PromoteService {
        releases: state.releases.as_deref(),
        promotions,
        feedback,
        actions: action_store,
    };
    state.refresh_vm_slot((state.clock)()).await;
    let vm = state.vm_slot.read().await.clone();
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_promote(&req.digest, &req.bake, &vm, &ctx)
        .map_err(|e| from_promote_error(e, sref, ROUTE))?;
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ActionChanged {
                id: 0,
                evaluated_at: now,
                action: handoff.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        CmdResponse {
            evaluated_at: now,
            action: handoff,
        },
    ))
}
