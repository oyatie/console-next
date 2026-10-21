/** Hands the browser a file to save under `name` (a download, never a navigation). */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  // The click has started the download; the URL is not needed after this task.
  setTimeout(() => URL.revokeObjectURL(url));
}
