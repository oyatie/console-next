-- SPDX-License-Identifier: LicenseRef-Proprietary
-- LINKS-CITATION-SCHEME-DB: enforce https://www.law.go.kr/... on nested
-- citation URLs inside statutory_rules.filing_rule (citation.source_url,
-- penalty.citation.source_url, and applicability_citations[].source_url).
-- Expand-only: adds and validates a CHECK constraint without dropping or
-- rewriting existing columns or constraints.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.statutory_rules
    ADD CONSTRAINT statutory_rules_filing_rule_citation_urls_check CHECK ((
        source_url LIKE 'https://www.law.go.kr/_%'
        AND source_url !~ '[[:space:][:cntrl:]]'
        AND (
            filing_rule IS NULL
            OR (
                jsonb_typeof(filing_rule) = 'object'
                AND jsonb_typeof(filing_rule->'citation') = 'object'
                AND jsonb_typeof(filing_rule->'citation'->'source_url') = 'string'
                AND (filing_rule->'citation'->>'source_url') LIKE 'https://www.law.go.kr/_%'
                AND (filing_rule->'citation'->>'source_url') !~ '[[:space:][:cntrl:]]'
                AND (
                    filing_rule->'penalty' IS NULL
                    OR jsonb_typeof(filing_rule->'penalty') = 'null'
                    OR (
                        jsonb_typeof(filing_rule->'penalty') = 'object'
                        AND jsonb_typeof(filing_rule->'penalty'->'citation') = 'object'
                        AND jsonb_typeof(filing_rule->'penalty'->'citation'->'source_url') = 'string'
                        AND (filing_rule->'penalty'->'citation'->>'source_url') LIKE 'https://www.law.go.kr/_%'
                        AND (filing_rule->'penalty'->'citation'->>'source_url') !~ '[[:space:][:cntrl:]]'
                    )
                )
                AND (
                    filing_rule->'applicability_citations' IS NULL
                    OR jsonb_typeof(filing_rule->'applicability_citations') = 'null'
                    OR (
                        jsonb_typeof(filing_rule->'applicability_citations') = 'array'
                        -- Lax mode detects missing members without a strict-path error.
                        AND NOT jsonb_path_exists(
                            filing_rule->'applicability_citations',
                            'lax $[*] ? (!exists(@.source_url))'
                        )
                        AND NOT jsonb_path_exists(
                            CASE
                                WHEN jsonb_typeof(filing_rule) = 'object'
                                 AND jsonb_typeof(filing_rule->'applicability_citations') = 'array'
                                THEN filing_rule->'applicability_citations'
                                ELSE '[]'::jsonb
                            END,
                            'strict $[*] ? (@.type() != "object" || @.source_url.type() != "string" || !(@.source_url starts with "https://www.law.go.kr/") || @.source_url == "https://www.law.go.kr/" || @.source_url like_regex "[[:space:][:cntrl:]]")'
                        )
                    )
                )
            )
        )
    ) IS TRUE) NOT VALID;

ALTER TABLE public.statutory_rules
    VALIDATE CONSTRAINT statutory_rules_filing_rule_citation_urls_check;
