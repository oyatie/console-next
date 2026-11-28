// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{TestResult, oc1_support};
use axum::http::StatusCode;
use oc1_support::{Oc1Harness, req_post, send_json};
use serde_json::{Value, json};

pub async fn record_decisions(
    h: &Oc1Harness,
    opened_ids: &[String],
    items: &[Value],
) -> TestResult {
    let cosigner = h.signer.sign(
        oc1_support::operator_fixture::COSIGNER_EMAIL,
        oc1_support::AUD,
        oc1_support::ISSUER,
        300,
        None,
    )?;
    for (idx, id) in opened_ids.iter().enumerate() {
        let mut payload = if idx % 2 == 0 {
            json!({
                "event": "done",
                "fields": {
                    "evidence_ref": format!("docs/ops/receipt-{idx}.md"),
                    "signer": "Reviewer",
                    "co_signer": "Second-Reviewer",
                    "counsel_url": format!("https://counsel.cosskorea.invalid/opinions/{idx}"),
                    "signed_on": "2026-11-23"
                }
            })
        } else {
            json!({
                "event": "waived",
                "fields": {
                    "reason": "Not required",
                    "signer": "Owner",
                    "co_signer": "Security-Lead",
                    "counsel_url": format!("docs/ops/waiver-{idx}.md")
                }
            })
        };
        let path = format!("/api/ops/v1/obligations/{id}/events");
        let gate = items[idx]["kind"] == "launch-gate";
        if gate {
            let (status, _, _) =
                send_json(&h.app, req_post(&path, &h.operator_jwt, payload.clone())).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let fields = payload["fields"].as_object_mut().ok_or("missing fields")?;
            fields.remove("signer");
            fields.remove("co_signer");
        }
        let (st, _, b) = send_json(&h.app, req_post(&path, &h.operator_jwt, payload)).await?;
        assert_eq!(st, StatusCode::OK, "{b}");
        if gate {
            assert_eq!(b["item"]["state"], "in-review");
            assert_eq!(b["item"]["signer"], "00000000-0000-4000-8000-000000000001");
            let seq = b["record"]["seq"].as_u64().ok_or("missing sequence")?;
            for (ref_jwt, proposed, expected) in [
                (&h.operator_jwt, seq, StatusCode::BAD_REQUEST),
                (&h.home_only_jwt, seq, StatusCode::FORBIDDEN),
                (&cosigner, seq + 1, StatusCode::BAD_REQUEST),
                (&cosigner, seq, StatusCode::OK),
            ] {
                let confirm = json!({"event":"countersigned","fields":{"proposal_seq":proposed}});
                let (status, _, body) =
                    send_json(&h.app, req_post(&path, ref_jwt, confirm)).await?;
                assert_eq!(status, expected, "{body}");
                if status == StatusCode::OK {
                    assert_eq!(
                        body["item"]["co_signer"],
                        "00000000-0000-4000-8000-000000000003"
                    );
                    assert_eq!(body["item"]["signer"], b["item"]["signer"]);
                }
            }
        }
    }
    Ok(())
}
