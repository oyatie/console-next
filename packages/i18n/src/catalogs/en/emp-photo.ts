// English for `empPhoto.` ids.
import type { koEmpPhoto } from "../ko/emp-photo";

export const enEmpPhoto: Partial<Record<keyof typeof koEmpPhoto, string>> = {
  "empPhoto.add": "Add photo",
  "empPhoto.edit": "Edit photo",
  "empPhoto.done": "Photo recorded",
  "empPhoto.drop": "Photo file",
  "empPhoto.preview": "Photo to upload {name}",
  "empPhoto.sending": "Uploading",
  "empPhoto.putFailed": "The photo store did not take the file (HTTP {status}) · upload it again",
  "empPhoto.unavailable": "This server has no photo store configured, so photos cannot be uploaded now · tell the operator",
};
