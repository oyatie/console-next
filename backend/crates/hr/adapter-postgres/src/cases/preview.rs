// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{TemplateItem, TemplatePreviewQuery};
use crate::{
    HrError, HrService,
    authz::{Tier, hr_reach_in},
};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use sqlx::{FromRow, Row};

impl HrService {
    pub async fn lifecycle_template_preview(
        &self,
        p: Principal,
        key: String,
    ) -> Result<Vec<TemplateItem>, HrError> {
        self.lifecycle_template_preview_for(p, key, TemplatePreviewQuery::default())
            .await
    }

    pub async fn lifecycle_template_preview_for(
        &self,
        p: Principal,
        key: String,
        q: TemplatePreviewQuery,
    ) -> Result<Vec<TemplateItem>, HrError> {
        hr_reach_in(&p, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move |tx|Box::pin(async move {
            let rows=sqlx::query("SELECT t.item_key,t.label_ko AS label,t.label_key,t.kind,t.owner_line,t.due_register_code AS rule_ref,\
              t.instrument_ko AS instrument,t.article_ko AS article,t.blocks_close,t.due_rule_kind,t.due_anchor,t.opens_rule_ref,\
              t.legal AND COALESCE(r.recording_held,c.release_disposition='HOLD') AS legal_review_required,\
              r.filing_rule->>'insurer' AS insurer,r.filing_rule->>'filing_kind' AS filing_kind,\
              COALESCE(r.filing_rule->>'opens_anchor',CASE WHEN r.case_opens_offset_days IS NOT NULL OR NOT t.legal THEN t.due_anchor END) AS opens_anchor,\
              COALESCE((r.filing_rule->>'opens_offset')::int,r.case_opens_offset_days,CASE WHEN NOT t.legal THEN 0 END) AS opens_offset_days,\
              COALESCE((r.filing_rule->'deadline'->>'value')::bigint,r.value_num/NULLIF(r.value_den,0)) AS due_rule_value,\
              COALESCE(r.filing_rule->'deadline'->>'kind',t.due_rule_kind) AS display_due_rule_kind,\
              COALESCE(r.filing_rule->'deadline'->>'anchor',t.due_anchor) AS display_due_anchor,\
              t.legal,t.due_register_code,t.opens_on AS fixed_opens,r.case_opens_offset_days,r.recording_held,c.release_disposition,\
              c.kind AS case_kind,$4::date AS effective_date,NULL::date AS requested_on,\
              lifecycle_go_live_on($5,NULL,COALESCE($4,current_date),NULL) AS go_live_on,\
              (now() AT TIME ZONE lifecycle_time_zone($5,NULL,COALESCE($4,current_date),NULL))::date AS today \
              FROM case_template_items t JOIN LATERAL (SELECT * FROM case_templates c \
                WHERE c.template_key=COALESCE((SELECT template_key FROM lifecycle_case_triggers WHERE event_type=$1),$1) \
                AND ($4::date IS NULL OR (c.effective_from<=$4 AND (c.effective_to_exclusive IS NULL OR $4<c.effective_to_exclusive))) \
                ORDER BY c.effective_from DESC,c.version DESC LIMIT 1) c ON c.template_key=t.template_key AND c.version=t.version \
              LEFT JOIN LATERAL (SELECT * FROM lifecycle_filing_rules r WHERE r.code=t.due_register_code \
                AND ($4::date IS NULL OR (r.effective_from<=$4 AND (r.effective_to_exclusive IS NULL OR $4<r.effective_to_exclusive))) \
                ORDER BY r.effective_from DESC LIMIT 1) r ON true \
              WHERE (t.variants IS NULL OR COALESCE($2,lifecycle_exit_variant($3))=ANY(t.variants)) ORDER BY t.ord")
                .bind(key).bind(q.variant).bind(q.exit_reason).bind(q.effective_date).bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await?;
            let register=console_platform_db::statutory_read::load_statutory_register(tx.as_mut()).await
                .map_err(|e|HrError::internal(e.to_string()))?;
            let mut items=Vec::with_capacity(rows.len());
            for row in rows {
                let mut item=TemplateItem::from_row(&row)?;
                if q.effective_date.is_some() {
                    let window=super::window::calculate(&row,&register)?;
                    let today:time::Date=row.try_get("today")?;
                    item.opens_on=window.opens.map(|date|date.to_string());
                    item.opens_in_days=window.opens.map(|date|(date-today).whole_days());
                    item.due_on=window.due.map(|date|date.to_string());
                    item.due_in_days=window.due.map(|date|(date-today).whole_days());
                    item.due_disposition=Some(window.disposition.to_owned());
                }
                item.due_rule_kind=row.try_get("display_due_rule_kind")?;
                item.due_anchor=row.try_get("display_due_anchor")?;
                items.push(item);
            }
            Ok((items,Vec::new()))
        })).await
    }
}
