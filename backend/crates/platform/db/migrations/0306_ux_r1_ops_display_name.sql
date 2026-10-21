-- UX-R1 ACCESS (company-17; design-language §7.1-7.2): the tenant ops account
-- was seeded with the English placeholder name 「Tenant Admin」, which every
-- history line then printed (「Tenant Admin님이 …」). Provisioning now seeds
-- 「운영 계정」; existing ops accounts still carrying the placeholder are
-- renamed. A name the tenant already changed is left alone.
--
-- Lane number (UX-R1 ACCESS range 0308-0309); INTEG renumbers at merge.
SET LOCAL lock_timeout = '2s';

UPDATE users SET display_name = '운영 계정'
 WHERE is_tenant_ops AND display_name = 'Tenant Admin';
