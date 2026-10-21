import type { koUiAddressField } from "../ko/ui-address-field";

export const enUiAddressField: Record<keyof typeof koUiAddressField, string> = {
  "uiAddressField.printed": "As printed:",
  "uiAddressField.jibun": "Lot {jibun}",
  "uiAddressField.zip": "Postcode {zip}",
  "uiAddressField.unverified": "Address not verified",
  "uiAddressField.change": "Find address again",
  "uiAddressField.detail": "Unit",
  "uiAddressField.detailExample": "3F, Room 301",
  "uiAddressField.loading": "Searching…",
  "uiAddressField.narrow": "Too many results. Type the road name and building number.",
  "uiAddressField.none": "No address found. Try the road name and building number, or the building name.",
  "uiAddressField.hint": "Search by road name and number, neighbourhood and lot number, or building name.",
  "uiAddressField.manual": "Type the address yourself",
  "uiAddressField.unavailable": "Address search is unavailable right now. A typed address is saved as “not verified” and matched again once search is back.",
  "uiAddressField.road": "Road-name address",
  "uiAddressField.roadExample": "209 Sejong-daero, Jongno-gu, Seoul",
  "uiAddressField.zipLabel": "Postcode (5 digits)",
  "uiAddressField.useManual": "Use this address",
  "uiAddressField.manualNeeds": "A road-name address and a 5-digit postcode are needed.",
  "uiAddressField.backToSearch": "Back to search",
};
