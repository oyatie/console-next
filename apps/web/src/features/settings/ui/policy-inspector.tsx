// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { ApiError, settingHistoryQuery } from "../../../reference/settings/api";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ExternalLink } from "../../../ui/external-link";
import { KeyValue } from "../../../ui/key-value/key-value";
import {
  formatEntryDefault,
  formatEntryLabel,
  formatEntryValue,
  isSettingEditable,
  type SettingEntry,
} from "../domain/catalog";
import { type SummaryCopy } from "../domain/summaries";
import s from "./settings-hub.module.css";

const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));

export function PolicyInspector({
  entry,
  canChange,
  onEdit,
}: {
  entry: SettingEntry;
  canChange: boolean;
  onEdit: () => void;
}) {
  const history = useQuery(settingHistoryQuery(entry.key));
  const editable = isSettingEditable(entry, canChange);
  const defaultText = formatEntryDefault(entry, settingsCopy);
  const governanceText = t(`settingsHub.governance.${entry.governance}`);
  const historyDenied = history.error instanceof ApiError && history.error.status === 403;

  return (
    <div className={s.stack}>
      <Card
        title={t("settingsHub.inspector.title")}
        tools={
          editable ? (
            <Button size="sm" variant="primary" onClick={onEdit}>
              {t("settingsHub.policy.edit")}
            </Button>
          ) : (
            <DisabledReason
              layout="disclosure"
              reason={entry.governance === "tenant" ? t("settingsHub.readOnly") : governanceText}
              control={(props) => (
                <Button {...props} size="sm" variant="secondary">
                  {t("settingsHub.policy.edit")}
                </Button>
              )}
            />
          )
        }
      >
        <KeyValue
          label={formatEntryLabel(entry, settingsCopy)}
          items={[
            {
              key: "current",
              label: formatEntryLabel(entry, settingsCopy),
              value: formatEntryValue(entry, entry.value, settingsCopy),
            },
            {
              key: "layer",
              label: t("settingsHub.workplace.chainTitle"),
              value: (
                <div className={s.chips}>
                  <Chip tone="info">{settingsCopy(`settingsHub.layer.${entry.source.layer}`)}</Chip>
                  {entry.governance !== "tenant" && <Chip tone="neutral">{governanceText}</Chip>}
                </div>
              ),
            },
            ...(defaultText
              ? [{ key: "default", label: t("settingsHub.policy.defaultValue", { value: "" }).replace(/:\s*$/, ""), value: defaultText }]
              : []),
          ]}
        />
      </Card>

      {entry.legal_basis && (
        <Card title={t("settingsHub.inspector.legalBasis")}>
          <ExternalLink href={entry.legal_basis.url}>
            {t("shellRoutes.pair", { primary: entry.legal_basis.authority, secondary: entry.legal_basis.title })}
          </ExternalLink>
        </Card>
      )}

      {entry.chain.length > 0 && (
        <Card title={t("settingsHub.inspector.chain")}>
          <div className={s.stack}>
            {entry.chain.map((link, idx) => (
              <div key={`${link.layer}-${link.scope_entity_id ?? idx}`} className={s.row}>
                <span>{t(`settingsHub.layer.${link.layer}`)}</span>
                <div className={s.chips}>
                  <span>{formatEntryValue(entry, link.value, settingsCopy)}</span>
                  {link.deciding && <Chip tone="ok">{t("settingsHub.workplace.deciding")}</Chip>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {entry.scheduled.length > 0 && (
        <Card title={t("settingsHub.inspector.scheduled")}>
          <div className={s.stack}>
            {entry.scheduled.map((next) => (
              <div key={next.id} className={s.row}>
                <span>{fmtDate(next.effective_from)}</span>
                <Chip tone="warn">{formatEntryValue(entry, next.value, settingsCopy)}</Chip>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title={t("settingsHub.inspector.history")}>
        {historyDenied ? (
          <Banner tone="info">{t("settingsHub.inspector.historyUnavailable")}</Banner>
        ) : history.isPending ? (
          <p className="muted">{t("common.loading")}</p>
        ) : history.error ? (
          <Banner tone="warn">{t("settingsHub.unknown")}</Banner>
        ) : (history.data?.items.length ?? 0) === 0 ? (
          <p className="muted">{t("settingsHub.inspector.historyEmpty")}</p>
        ) : (
          <div className={s.stack}>
            {history.data!.items.map((item) => (
              <div key={item.id} className={s.row}>
                <div>
                  <div>{formatEntryValue(entry, item.value, settingsCopy)}</div>
                  <div className="muted">
                    {t("shellRoutes.pair", { primary: fmtDate(item.effective_from), secondary: item.reason_code })}
                  </div>
                </div>
                <div className={s.chips}>
                  <Chip tone={item.direction === "loosen" ? "warn" : "info"}>
                    {t(`settingsHub.policy.direction.${item.direction}`)}
                  </Chip>
                  {item.onboarding_exempt && <Chip tone="ok">{t("settingsHub.inspector.exempt")}</Chip>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
