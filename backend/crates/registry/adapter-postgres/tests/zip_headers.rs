// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_kernel_core::UserId;
use console_registry_adapter_postgres::{PgRegistryError, PgRegistryStore};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inconsistent_zip_local_filename_is_refused_without_importing_rows(pool: PgPool) {
    let mut bytes = include_bytes!("../../rest/tests/fixtures/master-list.xlsx").to_vec();
    let name = b"xl/workbook.xml";
    let header = bytes
        .windows(30 + name.len())
        .position(|part| part.starts_with(b"PK\x03\x04") && &part[30..] == name)
        .unwrap();
    bytes[header + 30] = b'_';
    let count = || sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM registry_equipment");
    let before = count().fetch_one(&pool).await.unwrap();
    let result = PgRegistryStore::new(pool.clone())
        .import_master_list_bytes(UserId::new(), "inconsistent.xlsx", &bytes)
        .await;
    assert!(matches!(result, Err(PgRegistryError::Workbook(_))));
    assert_eq!(count().fetch_one(&pool).await.unwrap(), before);
}
