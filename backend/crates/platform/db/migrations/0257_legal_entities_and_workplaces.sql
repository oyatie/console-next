-- 법인 · 사업자등록 · 사업장 (entity-depth design §3; challenge A-1, A-4..A-8, A-11, A-12).
--
-- Lane number (head+1 of trunk dccb092); INTEG renumbers at merge
-- (migration-safety: contiguous versions).
--
-- One tenant holds N legal entities; each holds N workplaces (사업장) and N
-- business registrations (사업자등록: one per 사업장, or one per 법인 under
-- 사업자단위과세). Three record kinds, each an identity HEAD plus append-only,
-- effective-dated, TYPED revisions (no JSONB attribute bag; lists are child
-- tables).
--
-- Locked identity lives on the heads, so plain partial unique indexes enforce
-- it (a unique index over append-only revisions would see every version):
-- biz_kind/crn on legal_entities, brn on business_registrations, sub_serial
-- on workplaces. They change only through an identifier correction; after
-- 운영 시작 the head trigger refuses the change outright (BW-06 high path, not
-- built yet).
--
-- No seed rows. Writer crate: console-entity-adapter-postgres.
-- Delete: append-only. The only DELETE admitted is the platform force-remove
-- sweep (`app.platform_force_remove_org` = on, 0196/0250 pattern); the
-- back-reference FKs are DEFERRABLE so the sweep's descending-OID order cannot
-- trip on the head ↔ workplace cycle.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION entity_record_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only entity record % forbids %', TG_TABLE_NAME, TG_OP;
END $$;

CREATE FUNCTION entity_head_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'entity head % is never deleted; void it in setup or close it', TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- 1. entity_addresses: one structured Korean address (KrAddress). Rows are
--    immutable; a changed address is a new row referenced by a new revision.
CREATE TABLE entity_addresses (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    source          TEXT        NOT NULL CHECK (source IN ('JUSO', 'MANUAL_UNVERIFIED')),
    road_addr_part1 TEXT        NOT NULL CHECK (char_length(btrim(road_addr_part1)) BETWEEN 1 AND 200),
    road_addr_part2 TEXT        NULL CHECK (road_addr_part2 IS NULL OR char_length(road_addr_part2) <= 100),
    jibun_addr      TEXT        NULL CHECK (jibun_addr IS NULL OR char_length(jibun_addr) <= 200),
    eng_addr        TEXT        NULL CHECK (eng_addr IS NULL OR char_length(eng_addr) <= 300),
    zip_no          TEXT        NULL CHECK (zip_no IS NULL OR zip_no ~ '^[0-9]{5}$'),
    adm_cd          TEXT        NULL CHECK (adm_cd IS NULL OR adm_cd ~ '^[0-9]{10}$'),
    rn_mgt_sn       TEXT        NULL CHECK (rn_mgt_sn IS NULL OR rn_mgt_sn ~ '^[0-9]{12}$'),
    bd_mgt_sn       TEXT        NULL CHECK (bd_mgt_sn IS NULL OR bd_mgt_sn ~ '^[0-9]{25}$'),
    si_nm           TEXT        NOT NULL CHECK (char_length(btrim(si_nm)) BETWEEN 1 AND 40),
    sgg_nm          TEXT        NULL CHECK (sgg_nm IS NULL OR char_length(sgg_nm) <= 40),
    emd_nm          TEXT        NULL CHECK (emd_nm IS NULL OR char_length(emd_nm) <= 40),
    li_nm           TEXT        NULL CHECK (li_nm IS NULL OR char_length(li_nm) <= 40),
    bd_nm           TEXT        NULL CHECK (bd_nm IS NULL OR char_length(bd_nm) <= 100),
    udrt_yn         BOOLEAN     NULL,
    buld_mnnm       INTEGER     NULL CHECK (buld_mnnm IS NULL OR buld_mnnm >= 0),
    buld_slno       INTEGER     NULL CHECK (buld_slno IS NULL OR buld_slno >= 0),
    mt_yn           BOOLEAN     NULL,
    lnbr_mnnm       INTEGER     NULL CHECK (lnbr_mnnm IS NULL OR lnbr_mnnm >= 0),
    lnbr_slno       INTEGER     NULL CHECK (lnbr_slno IS NULL OR lnbr_slno >= 0),
    detail          TEXT        NULL CHECK (detail IS NULL OR char_length(detail) <= 100),
    as_printed      TEXT        NULL CHECK (as_printed IS NULL OR char_length(as_printed) <= 300),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    -- A juso-sourced row carries the codes the search returned.
    CONSTRAINT entity_addresses_juso_codes CHECK (
        source <> 'JUSO' OR (zip_no IS NOT NULL AND adm_cd IS NOT NULL AND bd_mgt_sn IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- 2. legal_entities: the 법인 / 개인사업자 identity head.
CREATE TABLE legal_entities (
    org_id                       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                           UUID        NOT NULL DEFAULT gen_random_uuid(),
    biz_kind                     TEXT        NULL CHECK (biz_kind IN ('CORPORATION', 'INDIVIDUAL', 'ID_NUMBER_ORG')),
    crn                          TEXT        NULL CHECK (crn IS NULL OR crn ~ '^[0-9]{13}$'),
    primary_workplace_id         UUID        NULL,
    head_office_workplace_id     UUID        NULL,
    head_office_has_no_workplace BOOLEAN     NOT NULL DEFAULT false,
    needs_confirmation           BOOLEAN     NOT NULL DEFAULT false,
    identity_locked_at           TIMESTAMPTZ NULL,
    closed_on                    DATE        NULL,
    voided_at                    TIMESTAMPTZ NULL,
    void_reason_code             TEXT        NULL CHECK (void_reason_code IS NULL OR char_length(btrim(void_reason_code)) BETWEEN 1 AND 100),
    created_change_mode          TEXT        NOT NULL CHECK (created_change_mode IN ('SETUP', 'GOVERNED', 'MIGRATION')),
    created_by                   UUID        NULL,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT legal_entities_kind_required CHECK (needs_confirmation OR voided_at IS NOT NULL OR biz_kind IS NOT NULL),
    CONSTRAINT legal_entities_crn_only_corporation CHECK (crn IS NULL OR biz_kind IS NULL OR biz_kind = 'CORPORATION'),
    CONSTRAINT legal_entities_head_office_choice CHECK (NOT (head_office_has_no_workplace AND head_office_workplace_id IS NOT NULL)),
    CONSTRAINT legal_entities_void_shape CHECK ((voided_at IS NULL) = (void_reason_code IS NULL)),
    CONSTRAINT legal_entities_actor CHECK (created_by IS NOT NULL OR created_change_mode = 'MIGRATION')
);
CREATE UNIQUE INDEX legal_entities_crn_open_uniq ON legal_entities (org_id, crn)
    WHERE crn IS NOT NULL AND voided_at IS NULL AND closed_on IS NULL;

CREATE FUNCTION legal_entities_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.id, NEW.created_change_mode, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_change_mode, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'legal_entities identity columns are immutable (id=%)', OLD.id;
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'legal entity % is voided and read-only', OLD.id;
    END IF;
    IF OLD.identity_locked_at IS NOT NULL
       AND ((NEW.biz_kind, NEW.crn) IS DISTINCT FROM (OLD.biz_kind, OLD.crn)
            OR NEW.identity_locked_at IS DISTINCT FROM OLD.identity_locked_at) THEN
        RAISE EXCEPTION 'legal entity % identity is locked (identifier_locked)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. legal_entity_revisions (+ representatives, directors)
CREATE TABLE legal_entity_revisions (
    org_id                     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                         UUID        NOT NULL DEFAULT gen_random_uuid(),
    legal_entity_id            UUID        NOT NULL,
    version                    INTEGER     NOT NULL CHECK (version >= 1),
    command_id                 UUID        NOT NULL,
    effective_from             DATE        NOT NULL,
    name                       TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    display_name               TEXT        NULL CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 40),
    representation_mode        TEXT        NULL CHECK (representation_mode IN ('SINGLE', 'SEVERAL', 'JOINT')),
    additional_representatives INTEGER     NOT NULL DEFAULT 0 CHECK (additional_representatives BETWEEN 0 AND 50),
    head_office_address_id     UUID        NULL,
    incorporated_on            DATE        NULL,
    fiscal_year_end_month      SMALLINT    NULL CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
    capital_won                BIGINT      NULL CHECK (capital_won IS NULL OR capital_won >= 0),
    vat_unit_mode              TEXT        NULL CHECK (vat_unit_mode IN ('PER_WORKPLACE', 'CONSOLIDATED_PAYMENT', 'UNIT_TAXATION')),
    vat_unit_mode_basis        TEXT        NULL CHECK (vat_unit_mode_basis IN ('DECLARED', 'SINGLE_REGISTRATION', 'CERTIFICATE_UNIT_TAXATION')),
    main_ksic_code             TEXT        NULL CHECK (main_ksic_code IS NULL OR main_ksic_code ~ '^[A-Z0-9]{1,6}$'),
    main_ksic_label            TEXT        NULL CHECK (main_ksic_label IS NULL OR char_length(main_ksic_label) <= 200),
    main_ksic_version          TEXT        NULL CHECK (main_ksic_version IS NULL OR char_length(main_ksic_version) <= 40),
    main_phone                 TEXT        NULL CHECK (main_phone IS NULL OR main_phone ~ '^\+[1-9][0-9]{7,14}$'),
    priority_support           TEXT        NULL CHECK (priority_support IN ('YES', 'NO')),
    priority_support_basis     TEXT        NULL CHECK (priority_support_basis IN ('ANNEX_1', 'SME_ACT', 'GRACE_5Y', 'NOT_ELIGIBLE')),
    large_group_member         BOOLEAN     NULL,
    change_mode                TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER', 'MIGRATION')),
    reason_code                TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    actor_id                   UUID        NULL,
    payload_digest             BYTEA       NOT NULL CHECK (octet_length(payload_digest) = 32),
    settings_snapshot          JSONB       NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, legal_entity_id, version),
    -- INTEG-1: one accepted command appends at most one revision (0214 shape).
    UNIQUE (org_id, command_id),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, head_office_address_id) REFERENCES entity_addresses (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT legal_entity_revisions_actor CHECK (actor_id IS NOT NULL OR change_mode = 'MIGRATION'),
    CONSTRAINT legal_entity_revisions_vat_basis CHECK ((vat_unit_mode IS NULL) = (vat_unit_mode_basis IS NULL)),
    CONSTRAINT legal_entity_revisions_priority_basis CHECK ((priority_support IS NULL) = (priority_support_basis IS NULL)),
    CONSTRAINT legal_entity_revisions_ksic_triple CHECK (
        (main_ksic_code IS NULL) = (main_ksic_label IS NULL) AND (main_ksic_code IS NULL) = (main_ksic_version IS NULL)
    ),
    -- Consequential facts are required unless a migration wrote the row
    -- (then the head is needs_confirmation until a person confirms).
    CONSTRAINT legal_entity_revisions_complete CHECK (
        change_mode = 'MIGRATION' OR representation_mode IS NOT NULL
    )
);

CREATE TABLE legal_entity_representatives (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    revision_id UUID        NOT NULL,
    seq         SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 50),
    name        TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, revision_id, seq),
    FOREIGN KEY (org_id, revision_id) REFERENCES legal_entity_revisions (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE legal_entity_directors (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    revision_id  UUID        NOT NULL,
    seq          SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 100),
    role         TEXT        NOT NULL CHECK (role IN ('REPRESENTATIVE_DIRECTOR', 'INSIDE_DIRECTOR', 'OUTSIDE_DIRECTOR', 'OTHER_NON_EXECUTIVE', 'AUDITOR')),
    name         TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    appointed_on DATE        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, revision_id, seq),
    FOREIGN KEY (org_id, revision_id) REFERENCES legal_entity_revisions (org_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 4. business_registrations: one 사업자등록 (one certificate).
CREATE TABLE business_registrations (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    legal_entity_id     UUID        NOT NULL,
    brn                 TEXT        NULL CHECK (brn IS NULL OR brn ~ '^[0-9]{10}$'),
    brn_pending_reason  TEXT        NULL CHECK (brn_pending_reason IN ('NEW_REGISTRATION_PENDING')),
    holder_workplace_id UUID        NULL,
    verification_tier   TEXT        NOT NULL DEFAULT 'NONE' CHECK (verification_tier IN ('NONE', 'T1', 'T2')),
    unverified_reason   TEXT        NULL CHECK (unverified_reason IN ('NEW_REGISTRATION_PENDING', 'SERVICE_UNAVAILABLE', 'NOT_CHECKED')),
    needs_confirmation  BOOLEAN     NOT NULL DEFAULT false,
    identity_locked_at  TIMESTAMPTZ NULL,
    closed_on           DATE        NULL,
    voided_at           TIMESTAMPTZ NULL,
    void_reason_code    TEXT        NULL CHECK (void_reason_code IS NULL OR char_length(btrim(void_reason_code)) BETWEEN 1 AND 100),
    created_change_mode TEXT        NOT NULL CHECK (created_change_mode IN ('SETUP', 'GOVERNED', 'MIGRATION')),
    created_by          UUID        NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT business_registrations_brn_or_pending CHECK (
        (brn IS NULL) = (brn_pending_reason IS NOT NULL) OR needs_confirmation
    ),
    CONSTRAINT business_registrations_void_shape CHECK ((voided_at IS NULL) = (void_reason_code IS NULL)),
    CONSTRAINT business_registrations_actor CHECK (created_by IS NOT NULL OR created_change_mode = 'MIGRATION')
);
CREATE UNIQUE INDEX business_registrations_brn_open_uniq ON business_registrations (org_id, brn)
    WHERE brn IS NOT NULL AND voided_at IS NULL AND closed_on IS NULL;
CREATE INDEX business_registrations_entity_idx ON business_registrations (org_id, legal_entity_id);

CREATE FUNCTION business_registrations_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.id, NEW.legal_entity_id, NEW.created_change_mode, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.legal_entity_id, OLD.created_change_mode, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'business_registrations identity columns are immutable (id=%)', OLD.id;
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'business registration % is voided and read-only', OLD.id;
    END IF;
    IF OLD.identity_locked_at IS NOT NULL
       AND (NEW.brn IS DISTINCT FROM OLD.brn OR NEW.identity_locked_at IS DISTINCT FROM OLD.identity_locked_at) THEN
        RAISE EXCEPTION 'business registration % number is locked (identifier_locked)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 5. workplaces: one 사업장. Backed by exactly one default branch (the
--    authorization spine), created in the same transaction (design §3.6).
CREATE TABLE workplaces (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    legal_entity_id     UUID        NOT NULL,
    registration_id     UUID        NULL,
    sub_serial          TEXT        NULL CHECK (sub_serial IS NULL OR (sub_serial ~ '^[0-9]{4}$' AND sub_serial <> '0000')),
    default_branch_id   UUID        NULL,
    needs_confirmation  BOOLEAN     NOT NULL DEFAULT false,
    closed_on           DATE        NULL,
    voided_at           TIMESTAMPTZ NULL,
    void_reason_code    TEXT        NULL CHECK (void_reason_code IS NULL OR char_length(btrim(void_reason_code)) BETWEEN 1 AND 100),
    created_change_mode TEXT        NOT NULL CHECK (created_change_mode IN ('SETUP', 'GOVERNED', 'MIGRATION')),
    created_by          UUID        NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (default_branch_id, org_id) REFERENCES branches (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT workplaces_branch_required CHECK (default_branch_id IS NOT NULL OR needs_confirmation OR voided_at IS NOT NULL),
    CONSTRAINT workplaces_void_shape CHECK ((voided_at IS NULL) = (void_reason_code IS NULL)),
    CONSTRAINT workplaces_actor CHECK (created_by IS NOT NULL OR created_change_mode = 'MIGRATION')
);
CREATE UNIQUE INDEX workplaces_branch_uniq ON workplaces (org_id, default_branch_id)
    WHERE default_branch_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX workplaces_sub_serial_uniq ON workplaces (org_id, registration_id, sub_serial)
    WHERE sub_serial IS NOT NULL AND voided_at IS NULL;
CREATE INDEX workplaces_entity_idx ON workplaces (org_id, legal_entity_id);

CREATE FUNCTION workplaces_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.id, NEW.legal_entity_id, NEW.created_change_mode, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.legal_entity_id, OLD.created_change_mode, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'workplaces identity columns are immutable (id=%)', OLD.id;
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'workplace % is voided and read-only', OLD.id;
    END IF;
    RETURN NEW;
END $$;

-- Back-references (the cycle): deferrable so the force-remove sweep and a
-- same-transaction create can order rows freely.
ALTER TABLE legal_entities
    ADD CONSTRAINT legal_entities_primary_workplace_fk FOREIGN KEY (org_id, primary_workplace_id)
        REFERENCES workplaces (org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT legal_entities_head_office_workplace_fk FOREIGN KEY (org_id, head_office_workplace_id)
        REFERENCES workplaces (org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE business_registrations
    ADD CONSTRAINT business_registrations_holder_fk FOREIGN KEY (org_id, holder_workplace_id)
        REFERENCES workplaces (org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 6. business_registration_revisions (+ business types, co-owners)
CREATE TABLE business_registration_revisions (
    org_id                  UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
    registration_id         UUID        NOT NULL,
    version                 INTEGER     NOT NULL CHECK (version >= 1),
    command_id              UUID        NOT NULL,
    effective_from          DATE        NOT NULL,
    trade_name              TEXT        NOT NULL CHECK (char_length(btrim(trade_name)) BETWEEN 1 AND 200),
    opened_on               DATE        NULL,
    business_address_id     UUID        NULL,
    production_factor       TEXT        NULL CHECK (production_factor IS NULL OR char_length(production_factor) <= 100),
    issue_reason_kind       TEXT        NULL CHECK (issue_reason_kind IN ('NEW', 'REISSUE', 'CORRECTION', 'OTHER_AS_PRINTED')),
    issue_reason_sub        TEXT        NULL CHECK (issue_reason_sub IN ('TRADE_NAME', 'RELOCATION', 'INDUSTRY', 'UNIT_TAXATION', 'REPRESENTATIVE', 'OTHER')),
    issue_reason_as_printed TEXT        NULL CHECK (issue_reason_as_printed IS NULL OR char_length(issue_reason_as_printed) <= 200),
    liquor_license_no       TEXT        NULL CHECK (liquor_license_no IS NULL OR char_length(btrim(liquor_license_no)) BETWEEN 1 AND 40),
    unit_taxation           BOOLEAN     NULL,
    e_invoice_email         TEXT        NULL CHECK (e_invoice_email IS NULL OR (char_length(e_invoice_email) <= 254 AND e_invoice_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
    cert_issued_on          DATE        NULL,
    tax_office_code         TEXT        NULL CHECK (tax_office_code IS NULL OR char_length(tax_office_code) <= 20),
    tax_office_label        TEXT        NULL CHECK (tax_office_label IS NULL OR char_length(btrim(tax_office_label)) BETWEEN 1 AND 60),
    tax_type                TEXT        NULL CHECK (tax_type IN ('01', '02', '03', '04', '05', '06', '07')),
    status                  TEXT        NOT NULL CHECK (status IN ('CONTINUING', 'SUSPENDED', 'CLOSED')),
    status_since            DATE        NULL,
    change_mode             TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER', 'MIGRATION')),
    reason_code             TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    actor_id                UUID        NULL,
    payload_digest          BYTEA       NOT NULL CHECK (octet_length(payload_digest) = 32),
    settings_snapshot       JSONB       NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, registration_id, version),
    UNIQUE (org_id, command_id),
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, business_address_id) REFERENCES entity_addresses (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT business_registration_revisions_actor CHECK (actor_id IS NOT NULL OR change_mode = 'MIGRATION'),
    CONSTRAINT business_registration_revisions_sub_reason CHECK (issue_reason_sub IS NULL OR issue_reason_kind = 'CORRECTION'),
    CONSTRAINT business_registration_revisions_status_since CHECK (status = 'CONTINUING' OR status_since IS NOT NULL),
    CONSTRAINT business_registration_revisions_complete CHECK (
        change_mode = 'MIGRATION' OR (
            opened_on IS NOT NULL AND business_address_id IS NOT NULL AND unit_taxation IS NOT NULL
            AND tax_office_label IS NOT NULL AND tax_type IS NOT NULL
        )
    )
);

CREATE TABLE business_registration_business_types (
    org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    revision_id       UUID        NOT NULL,
    seq               SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 50),
    is_main           BOOLEAN     NOT NULL,
    sector_as_printed TEXT        NOT NULL CHECK (char_length(btrim(sector_as_printed)) BETWEEN 1 AND 100),
    item_as_printed   TEXT        NOT NULL CHECK (char_length(btrim(item_as_printed)) BETWEEN 1 AND 200),
    nts_code          TEXT        NULL CHECK (nts_code IS NULL OR nts_code ~ '^[0-9]{6}$'),
    ksic_code         TEXT        NULL CHECK (ksic_code IS NULL OR ksic_code ~ '^[A-Z0-9]{1,6}$'),
    ksic_label        TEXT        NULL CHECK (ksic_label IS NULL OR char_length(ksic_label) <= 200),
    ksic_version      TEXT        NULL CHECK (ksic_version IS NULL OR char_length(ksic_version) <= 40),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, revision_id, seq),
    FOREIGN KEY (org_id, revision_id) REFERENCES business_registration_revisions (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX business_registration_business_types_one_main
    ON business_registration_business_types (org_id, revision_id) WHERE is_main;

CREATE TABLE business_registration_co_owners (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    revision_id UUID        NOT NULL,
    seq         SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 50),
    name        TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, revision_id, seq),
    FOREIGN KEY (org_id, revision_id) REFERENCES business_registration_revisions (org_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 7. workplace_revisions. Withholding is the ONLY filing link stored (VAT
--    follows registration_id, insurance its own revisions; challenge A-5).
CREATE TABLE workplace_revisions (
    org_id                 UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
    workplace_id           UUID        NOT NULL,
    version                INTEGER     NOT NULL CHECK (version >= 1),
    command_id             UUID        NOT NULL,
    effective_from         DATE        NOT NULL,
    name                   TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    address_id             UUID        NULL,
    mail_address_id        UUID        NULL,
    opened_on              DATE        NULL,
    representative_name    TEXT        NULL CHECK (representative_name IS NULL OR char_length(btrim(representative_name)) BETWEEN 1 AND 100),
    main_product           TEXT        NULL CHECK (main_product IS NULL OR char_length(main_product) <= 200),
    phone                  TEXT        NULL CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
    fax                    TEXT        NULL CHECK (fax IS NULL OR fax ~ '^\+[1-9][0-9]{7,14}$'),
    mobile                 TEXT        NULL CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{7,14}$'),
    email                  TEXT        NULL CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
    is_construction_site   BOOLEAN     NOT NULL DEFAULT false,
    status                 TEXT        NOT NULL CHECK (status IN ('CONTINUING', 'SUSPENDED', 'CLOSED')),
    status_since           DATE        NULL,
    withholding_mode       TEXT        NULL CHECK (withholding_mode IN ('HEAD_OFFICE', 'OWN_INDEPENDENT_ACCOUNTS', 'HEAD_OFFICE_BULK')),
    bulk_filed_on          DATE        NULL,
    independent_lsa_unit   BOOLEAN     NULL,
    independent_lsa_evidence TEXT      NULL CHECK (independent_lsa_evidence IS NULL OR char_length(btrim(independent_lsa_evidence)) BETWEEN 1 AND 500),
    change_mode            TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER', 'MIGRATION')),
    reason_code            TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    actor_id               UUID        NULL,
    payload_digest         BYTEA       NOT NULL CHECK (octet_length(payload_digest) = 32),
    settings_snapshot      JSONB       NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, workplace_id, version),
    UNIQUE (org_id, command_id),
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, address_id) REFERENCES entity_addresses (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, mail_address_id) REFERENCES entity_addresses (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT workplace_revisions_actor CHECK (actor_id IS NOT NULL OR change_mode = 'MIGRATION'),
    CONSTRAINT workplace_revisions_status_since CHECK (status = 'CONTINUING' OR status_since IS NOT NULL),
    CONSTRAINT workplace_revisions_bulk CHECK ((withholding_mode = 'HEAD_OFFICE_BULK') = (bulk_filed_on IS NOT NULL)),
    CONSTRAINT workplace_revisions_lsa_evidence CHECK (independent_lsa_unit IS NOT TRUE OR independent_lsa_evidence IS NOT NULL),
    CONSTRAINT workplace_revisions_complete CHECK (
        change_mode = 'MIGRATION' OR (address_id IS NOT NULL AND opened_on IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- 8. workplace_insurance_revisions: one row per insurer per change.
CREATE TABLE workplace_insurance_revisions (
    org_id                   UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                       UUID        NOT NULL DEFAULT gen_random_uuid(),
    workplace_id             UUID        NOT NULL,
    insurer                  TEXT        NOT NULL CHECK (insurer IN ('NPS', 'NHIS', 'EI', 'IACI')),
    version                  INTEGER     NOT NULL CHECK (version >= 1),
    command_id               UUID        NOT NULL,
    effective_from           DATE        NOT NULL,
    status                   TEXT        NOT NULL CHECK (status IN ('NOT_ESTABLISHED', 'ESTABLISHED', 'ESTABLISHED_NUMBER_PENDING', 'ENDED')),
    mgmt_no                  TEXT        NULL CHECK (mgmt_no IS NULL OR mgmt_no ~ '^[0-9]{8,13}$'),
    established_on           DATE        NULL,
    unit_mode                TEXT        NOT NULL CHECK (unit_mode IN ('OWN', 'PART_OF')),
    main_workplace_id        UUID        NULL,
    nps_separate_application BOOLEAN     NULL,
    nhis_unit_workplace_code TEXT        NULL CHECK (nhis_unit_workplace_code IS NULL OR char_length(nhis_unit_workplace_code) <= 20),
    nhis_branch_office_code  TEXT        NULL CHECK (nhis_branch_office_code IS NULL OR char_length(nhis_branch_office_code) <= 20),
    nhis_workplace_class     TEXT        NULL CHECK (nhis_workplace_class IN ('1', '3', '5', '7')),
    iaci_business_type_code  TEXT        NULL CHECK (iaci_business_type_code IS NULL OR char_length(iaci_business_type_code) <= 20),
    iaci_business_type_label TEXT        NULL CHECK (iaci_business_type_label IS NULL OR char_length(iaci_business_type_label) <= 200),
    iaci_insurance_year      SMALLINT    NULL CHECK (iaci_insurance_year BETWEEN 2000 AND 2100),
    iaci_business_form       TEXT        NULL CHECK (iaci_business_form IN ('CONTINUING', 'FIXED_TERM')),
    iaci_term_from           DATE        NULL,
    iaci_term_to             DATE        NULL,
    prime_contractor_mgmt_no TEXT        NULL CHECK (prime_contractor_mgmt_no IS NULL OR prime_contractor_mgmt_no ~ '^[0-9]{8,13}$'),
    change_mode              TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER', 'MIGRATION')),
    reason_code              TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    actor_id                 UUID        NULL,
    payload_digest           BYTEA       NOT NULL CHECK (octet_length(payload_digest) = 32),
    settings_snapshot        JSONB       NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, workplace_id, insurer, version),
    -- One command writes one row per insurer at most.
    UNIQUE (org_id, command_id, insurer),
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, main_workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT workplace_insurance_actor CHECK (actor_id IS NOT NULL OR change_mode = 'MIGRATION'),
    CONSTRAINT workplace_insurance_established CHECK (status <> 'ESTABLISHED' OR (mgmt_no IS NOT NULL AND established_on IS NOT NULL)),
    CONSTRAINT workplace_insurance_unit CHECK ((unit_mode = 'PART_OF') = (main_workplace_id IS NOT NULL)),
    CONSTRAINT workplace_insurance_not_self CHECK (main_workplace_id IS DISTINCT FROM workplace_id),
    CONSTRAINT workplace_insurance_nps_extras CHECK (insurer = 'NPS' OR nps_separate_application IS NULL),
    CONSTRAINT workplace_insurance_nhis_extras CHECK (
        insurer = 'NHIS' OR (nhis_unit_workplace_code IS NULL AND nhis_branch_office_code IS NULL AND nhis_workplace_class IS NULL)
    ),
    CONSTRAINT workplace_insurance_iaci_extras CHECK (
        insurer = 'IACI' OR (iaci_business_type_code IS NULL AND iaci_business_form IS NULL
                             AND iaci_term_from IS NULL AND prime_contractor_mgmt_no IS NULL)
    ),
    CONSTRAINT workplace_insurance_iaci_type CHECK (
        (iaci_business_type_code IS NULL) = (iaci_business_type_label IS NULL)
        AND (iaci_business_type_code IS NULL) = (iaci_insurance_year IS NULL)
    ),
    CONSTRAINT workplace_insurance_iaci_term CHECK (
        (iaci_business_form = 'FIXED_TERM') = (iaci_term_from IS NOT NULL AND iaci_term_to IS NOT NULL)
        AND (iaci_term_to IS NULL OR iaci_term_to >= iaci_term_from)
    )
);

-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------

-- 9. RLS, triggers, grants, classification (one block per table)

-- entity_addresses
ALTER TABLE entity_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entity_addresses
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_entity_addresses_org_immutable BEFORE UPDATE ON entity_addresses
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL PRIVILEGES ON entity_addresses FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON entity_addresses TO console_rt;
COMMENT ON TABLE entity_addresses IS 'Structured Korean address (도로명주소 juso fields or structured manual entry); immutable rows';
COMMENT ON COLUMN entity_addresses.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN entity_addresses.id IS 'pd:none — row id';
COMMENT ON COLUMN entity_addresses.source IS 'pd:none — JUSO (search result) | MANUAL_UNVERIFIED (structured manual entry, re-matched later)';
COMMENT ON COLUMN entity_addresses.road_addr_part1 IS 'pd:none — 도로명주소 without 참고항목';
COMMENT ON COLUMN entity_addresses.road_addr_part2 IS 'pd:none — 참고항목';
COMMENT ON COLUMN entity_addresses.jibun_addr IS 'pd:none — 지번주소';
COMMENT ON COLUMN entity_addresses.eng_addr IS 'pd:none — 영문주소';
COMMENT ON COLUMN entity_addresses.zip_no IS 'pd:none — 우편번호 (5 digits)';
COMMENT ON COLUMN entity_addresses.adm_cd IS 'pd:none — 행정구역코드 (10 digits)';
COMMENT ON COLUMN entity_addresses.rn_mgt_sn IS 'pd:none — 도로명코드';
COMMENT ON COLUMN entity_addresses.bd_mgt_sn IS 'pd:none — 건물관리번호';
COMMENT ON COLUMN entity_addresses.si_nm IS 'pd:none — 시도명';
COMMENT ON COLUMN entity_addresses.sgg_nm IS 'pd:none — 시군구명';
COMMENT ON COLUMN entity_addresses.emd_nm IS 'pd:none — 읍면동명';
COMMENT ON COLUMN entity_addresses.li_nm IS 'pd:none — 법정리명';
COMMENT ON COLUMN entity_addresses.bd_nm IS 'pd:none — 건물명';
COMMENT ON COLUMN entity_addresses.udrt_yn IS 'pd:none — 지하 여부';
COMMENT ON COLUMN entity_addresses.buld_mnnm IS 'pd:none — 건물본번';
COMMENT ON COLUMN entity_addresses.buld_slno IS 'pd:none — 건물부번';
COMMENT ON COLUMN entity_addresses.mt_yn IS 'pd:none — 산 여부';
COMMENT ON COLUMN entity_addresses.lnbr_mnnm IS 'pd:none — 지번본번';
COMMENT ON COLUMN entity_addresses.lnbr_slno IS 'pd:none — 지번부번 (juso lnbrSlno; meaning to verify against a live response)';
COMMENT ON COLUMN entity_addresses.detail IS 'pd:none — 상세주소 (동·층·호) entered by the user';
COMMENT ON COLUMN entity_addresses.as_printed IS 'pd:none — address text exactly as printed on the certificate, kept for comparison';
COMMENT ON COLUMN entity_addresses.created_at IS 'pd:none — row creation time';

-- legal_entities
ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON legal_entities
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_legal_entities_org_immutable BEFORE UPDATE ON legal_entities
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_legal_entities_head_guard BEFORE UPDATE ON legal_entities
    FOR EACH ROW EXECUTE FUNCTION legal_entities_head_guard();
CREATE TRIGGER trg_legal_entities_no_delete BEFORE DELETE ON legal_entities
    FOR EACH ROW EXECUTE FUNCTION entity_head_delete_guard();
REVOKE ALL PRIVILEGES ON legal_entities FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON legal_entities TO console_rt;
GRANT UPDATE (biz_kind, crn, primary_workplace_id, head_office_workplace_id, head_office_has_no_workplace, needs_confirmation, identity_locked_at, closed_on, voided_at, void_reason_code) ON legal_entities TO console_rt;
COMMENT ON TABLE legal_entities IS '법인 / 개인사업자 identity head; locked identity columns live here';
COMMENT ON COLUMN legal_entities.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN legal_entities.id IS 'pd:none — row id';
COMMENT ON COLUMN legal_entities.biz_kind IS 'pd:none — 사업자 구분: CORPORATION | INDIVIDUAL | ID_NUMBER_ORG';
COMMENT ON COLUMN legal_entities.crn IS 'pd:none — 법인등록번호, 13 digits canonical';
COMMENT ON COLUMN legal_entities.primary_workplace_id IS 'pd:none — 대표 사업장 (display/UI primary)';
COMMENT ON COLUMN legal_entities.head_office_workplace_id IS 'pd:none — 본점 사업장 (원천징수 납세지, 소득세법 §7①3)';
COMMENT ON COLUMN legal_entities.head_office_has_no_workplace IS 'pd:none — 본점 is an office only (no 사업장 record); withholding targets the entity head office';
COMMENT ON COLUMN legal_entities.needs_confirmation IS 'pd:none — written by a migration or vendor draft; a person must confirm';
COMMENT ON COLUMN legal_entities.identity_locked_at IS 'pd:none — when identity was locked (운영 시작); corrections then need a governed exception';
COMMENT ON COLUMN legal_entities.closed_on IS 'pd:none — date the record closed (폐업/종료); NULL while open';
COMMENT ON COLUMN legal_entities.voided_at IS 'pd:none — setup-phase void time (mistaken record); read-only after';
COMMENT ON COLUMN legal_entities.void_reason_code IS 'pd:none — reason code of the setup void';
COMMENT ON COLUMN legal_entities.created_change_mode IS 'pd:none — SETUP | GOVERNED | MIGRATION at creation';
COMMENT ON COLUMN legal_entities.created_by IS 'pd:personal — user who created the head (NULL only for MIGRATION)';
COMMENT ON COLUMN legal_entities.created_at IS 'pd:none — row creation time';

-- legal_entity_revisions
ALTER TABLE legal_entity_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON legal_entity_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_legal_entity_revisions_org_immutable BEFORE UPDATE ON legal_entity_revisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_legal_entity_revisions_append_only BEFORE UPDATE OR DELETE ON legal_entity_revisions
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON legal_entity_revisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON legal_entity_revisions TO console_rt;
COMMENT ON TABLE legal_entity_revisions IS 'Effective-dated typed history of a legal entity';
COMMENT ON COLUMN legal_entity_revisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN legal_entity_revisions.id IS 'pd:none — row id';
COMMENT ON COLUMN legal_entity_revisions.legal_entity_id IS 'pd:none — legal entity (법인/개인사업자)';
COMMENT ON COLUMN legal_entity_revisions.version IS 'pd:none — revision number per head';
COMMENT ON COLUMN legal_entity_revisions.command_id IS 'pd:none — the accepted command (Idempotency-Key) that appended this row';
COMMENT ON COLUMN legal_entity_revisions.effective_from IS 'pd:none — date the revision takes effect (KST); may be future';
COMMENT ON COLUMN legal_entity_revisions.name IS 'pd:none — 법인명 / 상호 as printed';
COMMENT ON COLUMN legal_entity_revisions.display_name IS 'pd:none — short label for chips and the scope switcher';
COMMENT ON COLUMN legal_entity_revisions.representation_mode IS 'pd:none — SINGLE | SEVERAL (각자대표) | JOINT (공동대표, 상법 §389②)';
COMMENT ON COLUMN legal_entity_revisions.additional_representatives IS 'pd:none — count of representatives printed as 외 n명 whose names are not on the document';
COMMENT ON COLUMN legal_entity_revisions.head_office_address_id IS 'pd:none — 본점 소재지';
COMMENT ON COLUMN legal_entity_revisions.incorporated_on IS 'pd:none — 회사성립연월일 (등기)';
COMMENT ON COLUMN legal_entity_revisions.fiscal_year_end_month IS 'pd:none — 결산월';
COMMENT ON COLUMN legal_entity_revisions.capital_won IS 'pd:none — 자본금 in KRW (등기)';
COMMENT ON COLUMN legal_entity_revisions.vat_unit_mode IS 'pd:none — PER_WORKPLACE | CONSOLIDATED_PAYMENT | UNIT_TAXATION (부가세법 §8③, §51)';
COMMENT ON COLUMN legal_entity_revisions.vat_unit_mode_basis IS 'pd:none — DECLARED | SINGLE_REGISTRATION (derived fact) | CERTIFICATE_UNIT_TAXATION (derived from 등록증 ⑩)';
COMMENT ON COLUMN legal_entity_revisions.main_ksic_code IS 'pd:none — 주된 업종 KSIC code (reference list)';
COMMENT ON COLUMN legal_entity_revisions.main_ksic_label IS 'pd:none — KSIC label at the time of choice';
COMMENT ON COLUMN legal_entity_revisions.main_ksic_version IS 'pd:none — KSIC list version';
COMMENT ON COLUMN legal_entity_revisions.main_phone IS 'pd:none — 대표 전화 (E.164)';
COMMENT ON COLUMN legal_entity_revisions.priority_support IS 'pd:none — 우선지원대상기업 YES | NO';
COMMENT ON COLUMN legal_entity_revisions.priority_support_basis IS 'pd:none — basis of the 우선지원 determination';
COMMENT ON COLUMN legal_entity_revisions.large_group_member IS 'pd:none — 상호출자제한기업집단 소속';
COMMENT ON COLUMN legal_entity_revisions.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER | MIGRATION — how the write was admitted';
COMMENT ON COLUMN legal_entity_revisions.reason_code IS 'pd:none — reason code of the change (BW-07 catalog)';
COMMENT ON COLUMN legal_entity_revisions.actor_id IS 'pd:personal — user who made the change (NULL only for MIGRATION)';
COMMENT ON COLUMN legal_entity_revisions.payload_digest IS 'pd:none — SHA-256 of the canonical revision payload';
COMMENT ON COLUMN legal_entity_revisions.settings_snapshot IS 'pd:none — phase and settings values the change was made under (D0.3)';
COMMENT ON COLUMN legal_entity_revisions.created_at IS 'pd:none — row creation time';

-- legal_entity_representatives
ALTER TABLE legal_entity_representatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity_representatives FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON legal_entity_representatives
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_legal_entity_representatives_org_immutable BEFORE UPDATE ON legal_entity_representatives
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_legal_entity_representatives_append_only BEFORE UPDATE OR DELETE ON legal_entity_representatives
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON legal_entity_representatives FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON legal_entity_representatives TO console_rt;
COMMENT ON TABLE legal_entity_representatives IS '대표자 names in printed order, per legal entity revision';
COMMENT ON COLUMN legal_entity_representatives.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN legal_entity_representatives.revision_id IS 'pd:none — revision this child row belongs to';
COMMENT ON COLUMN legal_entity_representatives.seq IS 'pd:none — printed order (1-based)';
COMMENT ON COLUMN legal_entity_representatives.name IS 'pd:personal — 대표자 성명 as printed (no RRN is ever stored)';
COMMENT ON COLUMN legal_entity_representatives.created_at IS 'pd:none — row creation time';

-- legal_entity_directors
ALTER TABLE legal_entity_directors ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity_directors FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON legal_entity_directors
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_legal_entity_directors_org_immutable BEFORE UPDATE ON legal_entity_directors
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_legal_entity_directors_append_only BEFORE UPDATE OR DELETE ON legal_entity_directors
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON legal_entity_directors FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON legal_entity_directors TO console_rt;
COMMENT ON TABLE legal_entity_directors IS '임원 from the 법인등기, per legal entity revision (no RRN, no address)';
COMMENT ON COLUMN legal_entity_directors.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN legal_entity_directors.revision_id IS 'pd:none — revision this child row belongs to';
COMMENT ON COLUMN legal_entity_directors.seq IS 'pd:none — printed order (1-based)';
COMMENT ON COLUMN legal_entity_directors.role IS 'pd:none — 임원 구분';
COMMENT ON COLUMN legal_entity_directors.name IS 'pd:personal — 임원 성명';
COMMENT ON COLUMN legal_entity_directors.appointed_on IS 'pd:personal — 취임일';
COMMENT ON COLUMN legal_entity_directors.created_at IS 'pd:none — row creation time';

-- business_registrations
ALTER TABLE business_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registrations
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_business_registrations_org_immutable BEFORE UPDATE ON business_registrations
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_business_registrations_head_guard BEFORE UPDATE ON business_registrations
    FOR EACH ROW EXECUTE FUNCTION business_registrations_head_guard();
CREATE TRIGGER trg_business_registrations_no_delete BEFORE DELETE ON business_registrations
    FOR EACH ROW EXECUTE FUNCTION entity_head_delete_guard();
REVOKE ALL PRIVILEGES ON business_registrations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON business_registrations TO console_rt;
GRANT UPDATE (brn, brn_pending_reason, holder_workplace_id, verification_tier, unverified_reason, needs_confirmation, identity_locked_at, closed_on, voided_at, void_reason_code) ON business_registrations TO console_rt;
COMMENT ON TABLE business_registrations IS 'One 사업자등록 (one 사업자등록증); the number is locked identity';
COMMENT ON COLUMN business_registrations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN business_registrations.id IS 'pd:none — row id';
COMMENT ON COLUMN business_registrations.legal_entity_id IS 'pd:none — legal entity (법인/개인사업자)';
COMMENT ON COLUMN business_registrations.brn IS 'pd:none — 사업자등록번호, 10 digits canonical';
COMMENT ON COLUMN business_registrations.brn_pending_reason IS 'pd:none — why no number yet (NEW_REGISTRATION_PENDING: 부가세법 §8 20-day window)';
COMMENT ON COLUMN business_registrations.holder_workplace_id IS 'pd:none — 사업장 the certificate was issued to (본점 under 사업자단위과세)';
COMMENT ON COLUMN business_registrations.verification_tier IS 'pd:none — 국세청 진위확인 tier reached: NONE | T1 | T2';
COMMENT ON COLUMN business_registrations.unverified_reason IS 'pd:none — why the number is saved unverified';
COMMENT ON COLUMN business_registrations.needs_confirmation IS 'pd:none — written by a migration or vendor draft; a person must confirm';
COMMENT ON COLUMN business_registrations.identity_locked_at IS 'pd:none — when identity was locked (운영 시작); corrections then need a governed exception';
COMMENT ON COLUMN business_registrations.closed_on IS 'pd:none — date the record closed (폐업/종료); NULL while open';
COMMENT ON COLUMN business_registrations.voided_at IS 'pd:none — setup-phase void time (mistaken record); read-only after';
COMMENT ON COLUMN business_registrations.void_reason_code IS 'pd:none — reason code of the setup void';
COMMENT ON COLUMN business_registrations.created_change_mode IS 'pd:none — SETUP | GOVERNED | MIGRATION at creation';
COMMENT ON COLUMN business_registrations.created_by IS 'pd:personal — user who created the head (NULL only for MIGRATION)';
COMMENT ON COLUMN business_registrations.created_at IS 'pd:none — row creation time';

-- workplaces
ALTER TABLE workplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplaces FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplaces
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplaces_org_immutable BEFORE UPDATE ON workplaces
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_workplaces_head_guard BEFORE UPDATE ON workplaces
    FOR EACH ROW EXECUTE FUNCTION workplaces_head_guard();
CREATE TRIGGER trg_workplaces_no_delete BEFORE DELETE ON workplaces
    FOR EACH ROW EXECUTE FUNCTION entity_head_delete_guard();
REVOKE ALL PRIVILEGES ON workplaces FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON workplaces TO console_rt;
GRANT UPDATE (registration_id, sub_serial, default_branch_id, needs_confirmation, closed_on, voided_at, void_reason_code) ON workplaces TO console_rt;
COMMENT ON TABLE workplaces IS 'One 사업장; backed by one default branch (authorization spine)';
COMMENT ON COLUMN workplaces.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN workplaces.id IS 'pd:none — row id';
COMMENT ON COLUMN workplaces.legal_entity_id IS 'pd:none — legal entity (법인/개인사업자)';
COMMENT ON COLUMN workplaces.registration_id IS 'pd:none — the 사업자등록 this 사업장 files VAT under (own, or the 사업자단위과세 one)';
COMMENT ON COLUMN workplaces.sub_serial IS 'pd:none — 종사업장 일련번호 (부표 ①) under 사업자단위과세';
COMMENT ON COLUMN workplaces.default_branch_id IS 'pd:none — branch backing this 사업장 for branch-scoped features';
COMMENT ON COLUMN workplaces.needs_confirmation IS 'pd:none — written by a migration or vendor draft; a person must confirm';
COMMENT ON COLUMN workplaces.closed_on IS 'pd:none — date the record closed (폐업/종료); NULL while open';
COMMENT ON COLUMN workplaces.voided_at IS 'pd:none — setup-phase void time (mistaken record); read-only after';
COMMENT ON COLUMN workplaces.void_reason_code IS 'pd:none — reason code of the setup void';
COMMENT ON COLUMN workplaces.created_change_mode IS 'pd:none — SETUP | GOVERNED | MIGRATION at creation';
COMMENT ON COLUMN workplaces.created_by IS 'pd:personal — user who created the head (NULL only for MIGRATION)';
COMMENT ON COLUMN workplaces.created_at IS 'pd:none — row creation time';

-- business_registration_revisions
ALTER TABLE business_registration_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_business_registration_revisions_org_immutable BEFORE UPDATE ON business_registration_revisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_business_registration_revisions_append_only BEFORE UPDATE OR DELETE ON business_registration_revisions
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON business_registration_revisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON business_registration_revisions TO console_rt;
COMMENT ON TABLE business_registration_revisions IS 'Effective-dated typed history of a 사업자등록 (certificate fields)';
COMMENT ON COLUMN business_registration_revisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN business_registration_revisions.id IS 'pd:none — row id';
COMMENT ON COLUMN business_registration_revisions.registration_id IS 'pd:none — the registration';
COMMENT ON COLUMN business_registration_revisions.version IS 'pd:none — revision number per head';
COMMENT ON COLUMN business_registration_revisions.command_id IS 'pd:none — the accepted command (Idempotency-Key) that appended this row';
COMMENT ON COLUMN business_registration_revisions.effective_from IS 'pd:none — date the revision takes effect (KST); may be future';
COMMENT ON COLUMN business_registration_revisions.trade_name IS 'pd:none — 상호 (법인명) as printed';
COMMENT ON COLUMN business_registration_revisions.opened_on IS 'pd:none — 개업연월일';
COMMENT ON COLUMN business_registration_revisions.business_address_id IS 'pd:none — 사업장 소재지';
COMMENT ON COLUMN business_registration_revisions.production_factor IS 'pd:none — 생산요소 as printed';
COMMENT ON COLUMN business_registration_revisions.issue_reason_kind IS 'pd:none — 발급 사유 kind (no official list; printed text kept)';
COMMENT ON COLUMN business_registration_revisions.issue_reason_sub IS 'pd:none — 정정 sub-reason (부가세법 영 §14①)';
COMMENT ON COLUMN business_registration_revisions.issue_reason_as_printed IS 'pd:none — 발급 사유 text as printed';
COMMENT ON COLUMN business_registration_revisions.liquor_license_no IS 'pd:none — 주류판매신고번호';
COMMENT ON COLUMN business_registration_revisions.unit_taxation IS 'pd:none — 사업자 단위 과세 적용사업자 여부 (⑩)';
COMMENT ON COLUMN business_registration_revisions.e_invoice_email IS 'pd:none — 전자세금계산서 전용 전자우편주소 (business address)';
COMMENT ON COLUMN business_registration_revisions.cert_issued_on IS 'pd:none — 발급일';
COMMENT ON COLUMN business_registration_revisions.tax_office_code IS 'pd:none — 관할 세무서 code (when the list is loaded)';
COMMENT ON COLUMN business_registration_revisions.tax_office_label IS 'pd:none — 관할 세무서 as printed';
COMMENT ON COLUMN business_registration_revisions.tax_type IS 'pd:none — 과세유형 (국세청 tax_type_cd 01-07)';
COMMENT ON COLUMN business_registration_revisions.status IS 'pd:none — CONTINUING | SUSPENDED | CLOSED (confirmed, not the observed NTS value)';
COMMENT ON COLUMN business_registration_revisions.status_since IS 'pd:none — date the status took effect';
COMMENT ON COLUMN business_registration_revisions.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER | MIGRATION — how the write was admitted';
COMMENT ON COLUMN business_registration_revisions.reason_code IS 'pd:none — reason code of the change (BW-07 catalog)';
COMMENT ON COLUMN business_registration_revisions.actor_id IS 'pd:personal — user who made the change (NULL only for MIGRATION)';
COMMENT ON COLUMN business_registration_revisions.payload_digest IS 'pd:none — SHA-256 of the canonical revision payload';
COMMENT ON COLUMN business_registration_revisions.settings_snapshot IS 'pd:none — phase and settings values the change was made under (D0.3)';
COMMENT ON COLUMN business_registration_revisions.created_at IS 'pd:none — row creation time';

-- business_registration_business_types
ALTER TABLE business_registration_business_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_business_types FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_business_types
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_business_registration_business_types_org_immutable BEFORE UPDATE ON business_registration_business_types
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_business_registration_business_types_append_only BEFORE UPDATE OR DELETE ON business_registration_business_types
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON business_registration_business_types FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON business_registration_business_types TO console_rt;
COMMENT ON TABLE business_registration_business_types IS '업태·종목 rows of a registration revision';
COMMENT ON COLUMN business_registration_business_types.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN business_registration_business_types.revision_id IS 'pd:none — revision this child row belongs to';
COMMENT ON COLUMN business_registration_business_types.seq IS 'pd:none — printed order (1-based)';
COMMENT ON COLUMN business_registration_business_types.is_main IS 'pd:none — 주업종 row';
COMMENT ON COLUMN business_registration_business_types.sector_as_printed IS 'pd:none — 업태 as printed';
COMMENT ON COLUMN business_registration_business_types.item_as_printed IS 'pd:none — 종목 as printed';
COMMENT ON COLUMN business_registration_business_types.nts_code IS 'pd:none — 국세청 업종코드 (6 digits; reference list)';
COMMENT ON COLUMN business_registration_business_types.ksic_code IS 'pd:none — KSIC code (reference list)';
COMMENT ON COLUMN business_registration_business_types.ksic_label IS 'pd:none — KSIC label at the time of choice';
COMMENT ON COLUMN business_registration_business_types.ksic_version IS 'pd:none — KSIC list version';
COMMENT ON COLUMN business_registration_business_types.created_at IS 'pd:none — row creation time';

-- business_registration_co_owners
ALTER TABLE business_registration_co_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_co_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_co_owners
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_business_registration_co_owners_org_immutable BEFORE UPDATE ON business_registration_co_owners
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_business_registration_co_owners_append_only BEFORE UPDATE OR DELETE ON business_registration_co_owners
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON business_registration_co_owners FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON business_registration_co_owners TO console_rt;
COMMENT ON TABLE business_registration_co_owners IS '공동사업자 names (개인 certificate ⑧); no RRN';
COMMENT ON COLUMN business_registration_co_owners.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN business_registration_co_owners.revision_id IS 'pd:none — revision this child row belongs to';
COMMENT ON COLUMN business_registration_co_owners.seq IS 'pd:none — printed order (1-based)';
COMMENT ON COLUMN business_registration_co_owners.name IS 'pd:personal — 공동사업자 성명';
COMMENT ON COLUMN business_registration_co_owners.created_at IS 'pd:none — row creation time';

-- workplace_revisions
ALTER TABLE workplace_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_revisions_org_immutable BEFORE UPDATE ON workplace_revisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_workplace_revisions_append_only BEFORE UPDATE OR DELETE ON workplace_revisions
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON workplace_revisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON workplace_revisions TO console_rt;
COMMENT ON TABLE workplace_revisions IS 'Effective-dated typed history of a 사업장';
COMMENT ON COLUMN workplace_revisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN workplace_revisions.id IS 'pd:none — row id';
COMMENT ON COLUMN workplace_revisions.workplace_id IS 'pd:none — the 사업장';
COMMENT ON COLUMN workplace_revisions.version IS 'pd:none — revision number per head';
COMMENT ON COLUMN workplace_revisions.command_id IS 'pd:none — the accepted command (Idempotency-Key) that appended this row';
COMMENT ON COLUMN workplace_revisions.effective_from IS 'pd:none — date the revision takes effect (KST); may be future';
COMMENT ON COLUMN workplace_revisions.name IS 'pd:none — 사업장 명칭';
COMMENT ON COLUMN workplace_revisions.address_id IS 'pd:none — 소재지';
COMMENT ON COLUMN workplace_revisions.mail_address_id IS 'pd:none — 우편물 수령지';
COMMENT ON COLUMN workplace_revisions.opened_on IS 'pd:none — 개설일';
COMMENT ON COLUMN workplace_revisions.representative_name IS 'pd:personal — 사업장의 장 / 부표 대표자';
COMMENT ON COLUMN workplace_revisions.main_product IS 'pd:none — 주생산품';
COMMENT ON COLUMN workplace_revisions.phone IS 'pd:none — 사업장 전화 (E.164)';
COMMENT ON COLUMN workplace_revisions.fax IS 'pd:none — 팩스 (E.164)';
COMMENT ON COLUMN workplace_revisions.mobile IS 'pd:personal — 담당 휴대전화 (E.164)';
COMMENT ON COLUMN workplace_revisions.email IS 'pd:personal — 담당 전자우편';
COMMENT ON COLUMN workplace_revisions.is_construction_site IS 'pd:none — 건설현장 여부';
COMMENT ON COLUMN workplace_revisions.status IS 'pd:none — CONTINUING | SUSPENDED | CLOSED (confirmed, not the observed NTS value)';
COMMENT ON COLUMN workplace_revisions.status_since IS 'pd:none — date the status took effect';
COMMENT ON COLUMN workplace_revisions.withholding_mode IS 'pd:none — 원천징수 단위: HEAD_OFFICE | OWN_INDEPENDENT_ACCOUNTS | HEAD_OFFICE_BULK; NULL = derived by statute';
COMMENT ON COLUMN workplace_revisions.bulk_filed_on IS 'pd:none — 본점일괄납부 승인일 (철회 3-year lockout anchor)';
COMMENT ON COLUMN workplace_revisions.independent_lsa_unit IS 'pd:none — 독립 사업 (근기법 적용 단위) declared fact';
COMMENT ON COLUMN workplace_revisions.independent_lsa_evidence IS 'pd:none — evidence reference for the 독립 사업 declaration';
COMMENT ON COLUMN workplace_revisions.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER | MIGRATION — how the write was admitted';
COMMENT ON COLUMN workplace_revisions.reason_code IS 'pd:none — reason code of the change (BW-07 catalog)';
COMMENT ON COLUMN workplace_revisions.actor_id IS 'pd:personal — user who made the change (NULL only for MIGRATION)';
COMMENT ON COLUMN workplace_revisions.payload_digest IS 'pd:none — SHA-256 of the canonical revision payload';
COMMENT ON COLUMN workplace_revisions.settings_snapshot IS 'pd:none — phase and settings values the change was made under (D0.3)';
COMMENT ON COLUMN workplace_revisions.created_at IS 'pd:none — row creation time';

-- workplace_insurance_revisions
ALTER TABLE workplace_insurance_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_insurance_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_insurance_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_insurance_revisions_org_immutable BEFORE UPDATE ON workplace_insurance_revisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_workplace_insurance_revisions_append_only BEFORE UPDATE OR DELETE ON workplace_insurance_revisions
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON workplace_insurance_revisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON workplace_insurance_revisions TO console_rt;
COMMENT ON TABLE workplace_insurance_revisions IS 'Effective-dated 4대보험 relation of a 사업장, per insurer';
COMMENT ON COLUMN workplace_insurance_revisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN workplace_insurance_revisions.id IS 'pd:none — row id';
COMMENT ON COLUMN workplace_insurance_revisions.workplace_id IS 'pd:none — the 사업장';
COMMENT ON COLUMN workplace_insurance_revisions.insurer IS 'pd:none — NPS | NHIS | EI | IACI';
COMMENT ON COLUMN workplace_insurance_revisions.version IS 'pd:none — revision number per head';
COMMENT ON COLUMN workplace_insurance_revisions.command_id IS 'pd:none — the accepted command (Idempotency-Key) that appended this row';
COMMENT ON COLUMN workplace_insurance_revisions.effective_from IS 'pd:none — date the revision takes effect (KST); may be future';
COMMENT ON COLUMN workplace_insurance_revisions.status IS 'pd:none — 보험관계 status; ESTABLISHED_NUMBER_PENDING = 성립, 번호 미입력';
COMMENT ON COLUMN workplace_insurance_revisions.mgmt_no IS 'pd:none — 사업장관리번호 (digits)';
COMMENT ON COLUMN workplace_insurance_revisions.established_on IS 'pd:none — 성립/적용일';
COMMENT ON COLUMN workplace_insurance_revisions.unit_mode IS 'pd:none — OWN | PART_OF (주된 사업장에 포함)';
COMMENT ON COLUMN workplace_insurance_revisions.main_workplace_id IS 'pd:none — 주된 사업장 when PART_OF';
COMMENT ON COLUMN workplace_insurance_revisions.nps_separate_application IS 'pd:none — 국민연금 분리적용';
COMMENT ON COLUMN workplace_insurance_revisions.nhis_unit_workplace_code IS 'pd:none — 건강보험 단위사업장기호';
COMMENT ON COLUMN workplace_insurance_revisions.nhis_branch_office_code IS 'pd:none — 건강보험 영업소기호';
COMMENT ON COLUMN workplace_insurance_revisions.nhis_workplace_class IS 'pd:none — 건강보험 사업장 구분 1/3/5/7';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_business_type_code IS 'pd:none — 산재 사업종류 code (보험연도 list)';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_business_type_label IS 'pd:none — 산재 사업종류 label';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_insurance_year IS 'pd:none — 보험연도 of the 사업종류 list';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_business_form IS 'pd:none — CONTINUING | FIXED_TERM';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_term_from IS 'pd:none — 유기사업 시작';
COMMENT ON COLUMN workplace_insurance_revisions.iaci_term_to IS 'pd:none — 유기사업 종료';
COMMENT ON COLUMN workplace_insurance_revisions.prime_contractor_mgmt_no IS 'pd:none — 원수급인 관리번호 (사내하도급)';
COMMENT ON COLUMN workplace_insurance_revisions.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER | MIGRATION — how the write was admitted';
COMMENT ON COLUMN workplace_insurance_revisions.reason_code IS 'pd:none — reason code of the change (BW-07 catalog)';
COMMENT ON COLUMN workplace_insurance_revisions.actor_id IS 'pd:personal — user who made the change (NULL only for MIGRATION)';
COMMENT ON COLUMN workplace_insurance_revisions.payload_digest IS 'pd:none — SHA-256 of the canonical revision payload';
COMMENT ON COLUMN workplace_insurance_revisions.settings_snapshot IS 'pd:none — phase and settings values the change was made under (D0.3)';
COMMENT ON COLUMN workplace_insurance_revisions.created_at IS 'pd:none — row creation time';

-- ---------------------------------------------------------------------------
-- 10. entity_commands: one row per accepted entity command (INTEG-1). The
--     request's Idempotency-Key is the command id; a replay with the same
--     request returns the recorded outcome, another request under the same
--     key is refused. Ids and codes only: replays re-read the records.
CREATE TABLE entity_commands (
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    command_id     UUID        NOT NULL,
    action         TEXT        NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
    request_digest BYTEA       NOT NULL CHECK (octet_length(request_digest) = 32),
    outcome        JSONB       NULL CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
    actor_id       UUID        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, command_id),
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
ALTER TABLE entity_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entity_commands
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_entity_commands_org_immutable BEFORE UPDATE ON entity_commands
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL PRIVILEGES ON entity_commands FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON entity_commands TO console_rt;
GRANT UPDATE (outcome) ON entity_commands TO console_rt;
COMMENT ON TABLE entity_commands IS 'Accepted 법인 · 사업장 commands by Idempotency-Key, for exactly-once replay';
COMMENT ON COLUMN entity_commands.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN entity_commands.command_id IS 'pd:none — the request Idempotency-Key';
COMMENT ON COLUMN entity_commands.action IS 'pd:none — command name (legal_entity.create, workplace.revise, …)';
COMMENT ON COLUMN entity_commands.request_digest IS 'pd:none — SHA-256 of the action and request body';
COMMENT ON COLUMN entity_commands.outcome IS 'pd:none — target id, change mode and count a replay returns (no personal values)';
COMMENT ON COLUMN entity_commands.actor_id IS 'pd:personal — user who sent the command';
COMMENT ON COLUMN entity_commands.created_at IS 'pd:none — when the command was accepted';
