// The login part of an account's sign-in ID (decisions #33): the server's rule (platform-auth sign_in_id.rs), why a
// change cannot be saved yet, and the suggestion an invite starts from (the romanised name, else the employee number).

const LOGIN = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
export const LOGIN_MAX = 32;

/** Trimmed, NFC, lowercase: what the server stores. */
export const normalizeLogin = (raw: string) => raw.trim().normalize("NFC").toLowerCase();

/** Why `raw` is not a login: `nonAscii` (Korean or full-width: the input-language key), `invalid` (the rule). */
export function loginProblem(raw: string): "empty" | "nonAscii" | "invalid" | null {
  const login = normalizeLogin(raw);
  if (login === "") return "empty";
  if (/[^\x20-\x7e]/.test(login)) return "nonAscii";
  return LOGIN.test(login) && !/[._-]{2}/.test(login) ? null : "invalid";
}

/** The first reason a change cannot be saved, in the order the form reads; `null` when it can. */
export function changeProblem(c: { current: string | null; next: string; date: string; today: string; reason: string | null; needsNote: boolean; note: string }) {
  const login = loginProblem(c.next);
  if (login) return login;
  if (c.current !== null && normalizeLogin(c.next) === c.current.split("@")[0]) return "unchanged";
  if (c.date === "") return "date";
  if (c.date > c.today) return "future";
  if (c.reason === null) return "reason";
  if (c.needsNote && c.note.trim() === "") return "note";
  return null;
}

// Revised Romanization of Korean (the 2000 national standard) by jamo index, without the sound-change rules: a suggestion the
// admin edits, never a value the server derives. Source holds no Hangul literal (copy gate): syllables are code points.
const INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWEL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINAL = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
// The common family names as people write them in passports (Kim, Lee, Park ...), keyed by code point.
const SURNAME: Record<number, string> = {
  0xae40: "kim", 0xc774: "lee", 0xbc15: "park", 0xcd5c: "choi", 0xc815: "jung", 0xac15: "kang", 0xc870: "cho",
  0xc724: "yoon", 0xc7a5: "jang", 0xc784: "lim", 0xc624: "oh", 0xc2e0: "shin", 0xad8c: "kwon", 0xc548: "ahn",
  0xb958: "ryu", 0xc720: "yoo", 0xbb38: "moon", 0xc190: "son", 0xb178: "noh", 0xc2ec: "shim", 0xace0: "ko", 0xad6c: "koo",
};

const syllable = (code: number) => {
  const i = code - 0xac00;
  return INITIAL[Math.floor(i / 588)]! + VOWEL[Math.floor((i % 588) / 28)]! + FINAL[i % 28]!;
};
const isSyllable = (code: number) => code >= 0xac00 && code <= 0xd7a3;

/** A Hangul name as `surname.given` (Hong Gildong → hong.gildong); a Latin name as `first.last`; `null` when neither fits. */
export function romanizeName(name: string): string | null {
  const text = name.trim().normalize("NFC");
  const codes = [...text].map((ch) => ch.codePointAt(0)!);
  if (codes.length >= 2 && codes.length <= 5 && codes.every(isSyllable)) {
    const [family, ...given] = codes;
    return `${SURNAME[family!] ?? syllable(family!)}.${given.map(syllable).join("")}`;
  }
  const latin = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(".");
  return latin && !loginProblem(latin) ? latin : null;
}

/** What an invite suggests: the romanised name, else the employee number, else nothing (the server's default). */
export function suggestLogin(name: string, employeeNumber?: string | null): string {
  const romanized = romanizeName(name);
  if (romanized && romanized.length <= LOGIN_MAX) return romanized;
  const number = normalizeLogin(employeeNumber ?? "").replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  return number && !loginProblem(number) ? number : "";
}
