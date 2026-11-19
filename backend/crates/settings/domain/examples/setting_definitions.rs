// SPDX-License-Identifier: LicenseRef-Proprietary
//! Generate definition upserts only for the registry keys passed on the command line.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_settings_domain::SettingKey;

#[path = "support/definition_sql.rs"]
mod definition_sql;

fn main() {
    let keys: Vec<SettingKey> = std::env::args()
        .skip(1)
        .map(|key| key.parse().expect("registered setting key"))
        .collect();
    assert!(
        !keys.is_empty(),
        "pass only the keys this migration adds or changes"
    );
    print!("{}", definition_sql::generated(&keys));
}
