// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) fn assert_refusal<T: std::fmt::Debug>(result: Result<T, KernelError>, code: &str) {
    assert_eq!(result.unwrap_err(), KernelError::validation(code));
}
pub(super) fn register() -> StatutoryRegister {
    StatutoryRegister::new(
        [
            codes::PIPA_ACCESS_RESPONSE_DAYS,
            codes::PIPA_CORRECTION_RESPONSE_DAYS,
            codes::PIPA_SUSPENSION_RESPONSE_DAYS,
        ]
        .into_iter()
        .map(|code| StatutoryRule {
            code: code.into(),
            effective_from: date!(2026 - 09 - 11),
            effective_to_exclusive: None,
            unit: StatutoryUnit::Days,
            value_num: 10,
            value_den: 1,
            citation: Citation {
                instrument_ko: "개인정보 보호법 시행령".into(),
                article_ko: "제41조·제43조·제44조".into(),
                source_url: "https://www.law.go.kr/법령/개인정보보호법시행령".into(),
            },
            disposition: ReleaseDisposition::Hold,
        })
        .collect(),
        vec![],
    )
    .unwrap()
}
pub(super) fn receipt(on: Date) -> Receipt {
    Receipt {
        id: Uuid::new_v4(),
        controller: Controller::Tenant,
        channel: Channel::InApp,
        agent: AgentKind::Subject,
        mandate_received: false,
        identity_method: IdentityMethod::SignedIn,
        identity_at: time::OffsetDateTime::UNIX_EPOCH,
        received_on: on,
    }
}
pub(super) fn request(kinds: &[Kind]) -> RightsRequest {
    RightsRequest::receive(
        receipt(date!(2026 - 10 - 27)),
        kinds.iter().copied(),
        &register(),
        date!(2026 - 10 - 27),
        None,
    )
    .unwrap()
}
pub(super) fn decision(outcome: Outcome, reason: Option<Ground>) -> Decision {
    Decision {
        outcome,
        reason: reason.map(|r| {
            serde_json::to_value(r)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        }),
        note: Some("법정 근거와 조치 내용을 확인했습니다.".into()),
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum Ground {
    LawProhibits,
    HarmToOthers,
    RequiredByLaw,
    LawRequires,
    ContractPerformance,
    JustifiedReason,
}
pub(super) fn reason_codes() -> BTreeMap<String, Vec<String>> {
    [
        (
            "privacy_refusal_access",
            vec!["LAW_PROHIBITS", "HARM_TO_OTHERS"],
        ),
        ("privacy_refusal_deletion", vec!["REQUIRED_BY_LAW"]),
        (
            "privacy_refusal_suspension",
            vec!["LAW_REQUIRES", "HARM_TO_OTHERS", "CONTRACT_PERFORMANCE"],
        ),
        ("privacy_postpone_access", vec!["JUSTIFIED_REASON"]),
    ]
    .into_iter()
    .map(|(d, codes)| (d.into(), codes.into_iter().map(str::to_owned).collect()))
    .collect()
}
