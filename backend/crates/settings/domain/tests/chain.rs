// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{
    OverrideRow, SettingKey as K, SettingValue as V, resolve, resolve_chain,
};
use time::{Duration, OffsetDateTime, macros::datetime};
use uuid::Uuid;

const NOW: OffsetDateTime = datetime!(2026-10-28 00:00 UTC);
fn row(id: u128, scope: Option<Uuid>, days: i64, value: i64) -> OverrideRow {
    OverrideRow {
        id: Uuid::from_u128(id),
        scope_entity_id: scope,
        effective_from: NOW + Duration::days(days),
        value: V::Int(value),
    }
}

#[test]
fn workplace_then_legal_entity_then_tenant_and_future_rows_wait() {
    let (workplace, entity) = (Uuid::from_u128(1), Uuid::from_u128(2));
    let rows = [
        row(3, None, -2, 25),
        row(4, Some(entity), -1, 20),
        row(5, Some(workplace), 1, 10),
    ];
    let key = K::ApprovalDelegationMaxDays;
    assert_eq!(
        resolve_chain(key, &rows, &[workplace, entity], NOW)
            .unwrap()
            .value,
        V::Int(20)
    );
    assert_eq!(
        resolve_chain(key, &rows, &[workplace, entity], NOW + Duration::days(1))
            .unwrap()
            .value,
        V::Int(10)
    );
    assert_eq!(
        resolve_chain(key, &rows[..1], &[workplace, entity], NOW)
            .unwrap()
            .value,
        V::Int(25)
    );
}

#[test]
fn one_scope_chain_preserves_every_registry_keys_value_and_version() {
    let entity = Uuid::from_u128(1);
    for &key in K::ALL {
        let rows = key
            .def()
            .default
            .map(|v| OverrideRow {
                id: Uuid::from_u128(2),
                scope_entity_id: Some(entity),
                value: v,
                effective_from: NOW,
            })
            .into_iter()
            .collect::<Vec<_>>();
        for scope in [None, Some(entity)] {
            assert_eq!(
                resolve_chain(key, &rows, scope.as_slice(), NOW),
                resolve(key, &rows, scope, NOW)
            );
        }
    }
}
