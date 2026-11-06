// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) fn ledger_csv(items: &[LocationConsentLedgerEntry]) -> Result<String, KernelError> {
    let mut csv =
        "id,consent_id,user_id,branch_id,actor,action,from_status,to_status,occurred_at,created_at\n"
            .to_owned();
    for item in items {
        let actor = item
            .actor
            .map(|actor| actor.to_string())
            .unwrap_or_default();
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            csv_field(&item.id),
            csv_field(&item.consent_id),
            csv_field(&item.user_id.to_string()),
            csv_field(&item.branch_id.to_string()),
            csv_field(&actor),
            csv_field(&item.action),
            csv_field(item.from_status.as_db_str()),
            csv_field(item.to_status.as_db_str()),
            csv_field(&console_kernel_core::rfc3339(item.occurred_at)?),
            csv_field(&console_kernel_core::rfc3339(item.created_at)?),
        ));
    }
    Ok(csv)
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod timestamp_tests {
    use super::*;

    #[test]
    fn ledger_export_normalizes_offsets_and_refuses_invalid_rfc3339() {
        let at = time::macros::datetime!(2026-11-05 12:31:02.238349 +09:00);
        let mut entry = LocationConsentLedgerEntry {
            id: "entry".into(),
            consent_id: "consent".into(),
            user_id: UserId::new(),
            branch_id: BranchId::new(),
            actor: None,
            action: "consent.grant".into(),
            from_status: LocationConsentState::NoRecord,
            to_status: LocationConsentState::Granted,
            occurred_at: at,
            created_at: at,
        };
        let csv = ledger_csv(&[entry.clone()]).unwrap();
        assert!(csv.ends_with(",2026-11-05T03:31:02.238349Z,2026-11-05T03:31:02.238349Z\n"));
        entry.created_at = time::macros::datetime!(-0001-01-01 00:00 UTC);
        assert!(ledger_csv(&[entry]).is_err());
    }
}
