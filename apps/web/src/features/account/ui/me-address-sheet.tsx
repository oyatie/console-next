// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { krAddress, type AddrDraft } from "../../../reference/entity/domain/address";
import { useAddressSearch } from "../../../reference/entity/ui/use-address-search";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { createMyProfileChangeRequest } from "../api";
import { SelfChangeRequestSheet } from "./me-edit-sheet";
import s from "./account.module.css";

export function AddressChangeButton() {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [picked, setPicked] = useState<AddrDraft | null>(null);
  const [road, setRoad] = useState("");
  const [zip, setZip] = useState("");
  const [detail, setDetail] = useState("");
  const [note, setNote] = useState("");
  const search = useAddressSearch();

  const save = useCommand({
    run: (draft: AddrDraft) =>
      createMyProfileChangeRequest({
        field: "address",
        address: krAddress({ ...draft, detail }),
        note: note.trim() || null,
      }),
    invalidates: ["/api/v1/me/profile", "/api/v1/change-requests"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.selfEdit.addressSaved"),
  });

  const resetAll = () => {
    setManual(false);
    setPicked(null);
    setRoad("");
    setZip("");
    setDetail("");
    setNote("");
    search.setQuery("");
    save.reset();
  };

  const close = () => {
    if (save.isSending) return;
    setOpen(false);
    resetAll();
  };

  const typingManual = manual || search.problem === "unavailable";
  const manualValid = road.trim().length >= 5 && /^\d{5}$/.test(zip);
  const readyDraft: AddrDraft | null = picked
    ? picked
    : typingManual && manualValid
      ? { road: road.trim(), zip, detail: detail.trim(), verified: false }
      : null;

  return (
    <SelfChangeRequestSheet
      open={open}
      title={t("account.selfEdit.addressEditTitle")}
      isSending={save.isSending}
      isPending={save.isPending}
      error={save.error}
      submitDisabled={!readyDraft}
      onOpen={() => {
        resetAll();
        setOpen(true);
      }}
      onClose={close}
      onSubmit={() => {
        if (save.isPending || !readyDraft) return;
        save.mutate(readyDraft);
      }}
    >
          {picked ? (
            <div className={s.contactGroup}>
              <div className={s.contactRowHead}>
                <strong className="t-sm">{picked.road}</strong>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setPicked(null)}
                >
                  {t("uiAddressField.change")}
                </Button>
              </div>
              <div className="t-xs muted num">{t("uiAddressField.zip", { zip: picked.zip })}</div>
            </div>
          ) : typingManual ? (
            <div className={s.form}>
              {search.problem === "unavailable" && (
                <div role="status" className="t-xs muted">
                  {t("uiAddressField.unavailable")}
                </div>
              )}
              <Field label={t("uiAddressField.road")} required>
                {(props) => (
                  <TextInput
                    {...props}
                    value={road}
                    placeholder={t("uiAddressField.roadExample")}
                    onChange={(e) => setRoad(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("uiAddressField.zipLabel")} required>
                {(props) => (
                  <TextInput
                    {...props}
                    className="code"
                    inputMode="numeric"
                    maxLength={5}
                    value={zip}
                    onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                  />
                )}
              </Field>
              {search.problem !== "unavailable" && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setManual(false)}>
                  {t("uiAddressField.backToSearch")}
                </Button>
              )}
            </div>
          ) : (
            <div className={s.form}>
              <Field label={t("account.selfEdit.address")} required>
                {(props) => (
                  <TextInput
                    {...props}
                    value={search.query}
                    placeholder={t("uiAddressField.hint")}
                    onChange={(e) => search.setQuery(e.target.value)}
                  />
                )}
              </Field>
              {search.loading && (
                <div role="status" className="t-xs muted">
                  {t("uiAddressField.loading")}
                </div>
              )}
              {search.problem === "narrow" && (
                <div className="t-xs muted">{t("uiAddressField.narrow")}</div>
              )}
              {search.hits.length > 0 && (
                <ul className="list-divided list-divided--rows" aria-label={t("account.selfEdit.address")}>
                  {search.hits.slice(0, 5).map((hit) => (
                    <li key={hit.key} className={s.editRow}>
                      <div className={s.editRowBody}>
                        <strong className="t-sm">{hit.road}</strong>
                        <div className="t-xs muted num">{hit.zip}</div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className={s.actionBtn}
                        onClick={() => {
                          setPicked(
                            search.withCodes({
                              key: hit.key,
                              road: hit.road,
                              jibun: hit.jibun,
                              zip: hit.zip,
                              detail: "",
                              verified: true,
                            }),
                          );
                        }}
                      >
                        {t("account.selfEdit.addressPick")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setManual(true)}>
                {t("uiAddressField.manual")}
              </Button>
            </div>
          )}

          <Field label={t("uiAddressField.detail")} required={false}>
            {(props) => (
              <TextInput
                {...props}
                maxLength={100}
                value={detail}
                placeholder={t("uiAddressField.detailExample")}
                onChange={(e) => setDetail(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("account.selfEdit.addressNote")} required={false}>
            {(props) => (
              <TextInput
                {...props}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
    </SelfChangeRequestSheet>
  );
}
