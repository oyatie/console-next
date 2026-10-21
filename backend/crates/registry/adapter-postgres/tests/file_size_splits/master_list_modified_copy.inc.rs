#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn modified_copy_reports_single_update(pool: PgPool) {
    console_platform_request_context::scope_org(console_kernel_core::OrgId::one(), async move {
        let store = PgRegistryStore::new(pool.clone());
        store.import_master_list(&master_list_path()).await.unwrap();

        let modified = copy_master_list("registry-modified-copy.xlsx");
        rewrite_cell(
            &modified,
            "가상물류 지게차 Master list",
            "Q293",
            "SYN900X-MOD",
        );

        let report = store.import_master_list(&modified).await.unwrap();
        assert_eq!(report.added, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.unchanged, 444);
        assert!(report.errors.is_empty(), "{:#?}", report.errors);

        let lookup = store.find_model_by_management_no("290").await.unwrap();
        assert_eq!(lookup.as_deref(), Some("SYN900X-MOD"));
    })
    .await;
}
