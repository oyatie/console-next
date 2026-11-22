// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::bundle::OncallConfig;
use console_ops_domain::changes::CmdHandOff;
use console_ops_domain::{Observed, ObservedTimestamp, UtcTimestamp};
use serde::Serialize;
use time::OffsetDateTime;

use crate::actions::{ActionStore, CmdHandOffInput};
use crate::obligations::{Context, Error as SpoolError};
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_ONCALL_SYNTHETIC_PAGE_OK, QUERY_ONCALL_SYNTHETIC_PAGE_TS, VictoriaMetricsSnapshot,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OncallView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<OncallConfig>,
    pub display_status: Observed<String>,
    pub last_page_test_at: ObservedTimestamp,
    pub last_page_test_ok: Observed<bool>,
}

pub struct OncallService;

impl OncallService {
    pub fn build_view(
        config: Option<&OncallConfig>,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        now: OffsetDateTime,
    ) -> OncallView {
        let display_status = match config {
            Some(cfg) => Observed::current(
                cfg.display_status.clone(),
                None,
                "bundle".to_owned(),
                now,
                now,
                vm.interval_s,
            ),
            None => Observed::unknown("bundle".to_owned(), "not instrumented".to_owned()),
        };

        let first_val = |q: &str| vm.current.as_ref()?.series.get(q)?.first().map(|s| s.value);
        let last_at = first_val(QUERY_ONCALL_SYNTHETIC_PAGE_TS)
            .filter(|v| *v > 0.0)
            .and_then(|v| OffsetDateTime::from_unix_timestamp(v as i64).ok())
            .map(UtcTimestamp::new);
        let last_ok = first_val(QUERY_ONCALL_SYNTHETIC_PAGE_OK).map(|v| v > 0.0);

        OncallView {
            evaluated_at: now,
            config: config.cloned(),
            display_status,
            last_page_test_at: vm.observe(last_at, None, now),
            last_page_test_ok: vm.observe(last_ok, None, now),
        }
    }

    pub fn request_page_test(
        actions: &dyn ActionStore,
        context: &Context,
    ) -> Result<CmdHandOff, SpoolError> {
        let rec = actions.record_handoff(
            &CmdHandOffInput {
                kind: "oncall-page-test",
                command: "sudo systemctl start console-oncall-test.service",
                target: "oncall-test",
                consequence: "Sends synthetic on-call page via relay and updates oncall.prom",
                expected_result: "console_oncall_synthetic_page_ok == 1 and timestamp advances",
                verify_step: "Verify /oncall shows updated synthetic page test result",
            },
            context,
        )?;
        Ok(rec.handoff)
    }
}
