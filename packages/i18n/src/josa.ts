/**
 * Korean particles depend on whether the preceding word ends in a final consonant (받침).
 * Catalog messages write `{name|을를}`; the formatter appends the right particle to the value.
 */
const PAIRS = { 을를: ["을", "를"], 이가: ["이", "가"], 은는: ["은", "는"], 과와: ["과", "와"], 으로로: ["으로", "로"], 아야: ["아", "야"] } as const;
export type JosaPair = keyof typeof PAIRS;

/** Closing marks a particle may follow: a parenthesis, a quote or a bracket closes the word it belongs to. */
const CLOSERS = new Set([")", "」", "』", "”", "’", '"', "'", "]", "》", "〉"]);
/** Full-width forms (）］＂) count as their ASCII closers. */
const isCloser = (ch: string) => CLOSERS.has(ch.normalize("NFKC"));

/** The last syllable of each digit's and letter's Korean reading (3 → 삼, R → 알, X → 엑스). */
const DIGIT_READING = "영일이삼사오육칠팔구";
const LETTER_READING: Record<string, string> = {
  A: "이", B: "비", C: "씨", D: "디", E: "이", F: "프", G: "지", H: "치", I: "이", J: "이", K: "이", L: "엘", M: "엠",
  N: "엔", O: "오", P: "피", Q: "큐", R: "알", S: "스", T: "티", U: "유", V: "이", W: "유", X: "스", Y: "이", Z: "트",
};
/**
 * How a Latin word's ending is read in Korean loanword spelling, as a syllable with that final sound
 * (Google → 구글, Mac → 맥, App → 앱, Test → 테스트, Internet → 인터넷). First match wins.
 */
const WORD_ENDINGS: [RegExp, string][] = [
  // Endings whose reading breaks the rules below (GitHub → 깃허브, Paycheck → 페이체크, KakaoTalk → 카카오톡).
  [/hub$/, "브"],
  [/check$/, "크"],
  [/talk$/, "톡"],
  [/^(?:bit|kit|hit|jet)$/, "트"], // 비트, 키트, 히트, 제트
  // A short vowel before a final t or k closes the syllable (Net → 넷, Asset → 애셋, Facebook → 페이스북).
  [/(?:^|[^aeiou])[aeiou]t$|out$/, "넷"],
  [/(?:^|[^aeiou])[aeiou]k$|ook$/, "북"],
  [/ng$/, "링"],
  [/(?:l|le)$/, "글"],
  [/(?:m|[aeiou]me)$/, "임"],
  [/(?:n|[aeioun]ne)$/, "인"],
  [/(?:ck|[aeiou]c)$/, "맥"],
  [/(?:[aeiou]|p)p$/, "앱"],
  [/(?:[aeiou]|b)b$/, "웹"],
  [/[^aeiou][tkp]$/, "트"],
  [/[aeiouydgsxzfvhwr]$/, "어"],
];

/** The Korean reading of the text's last character or word, as a Hangul syllable; undefined when unknown. */
function reading(text: string): string | undefined {
  const ch = text.at(-1);
  if (!ch) return undefined;
  if (ch >= "가" && ch <= "힣") return ch;
  if (ch >= "0" && ch <= "9") return DIGIT_READING[Number(ch)];
  if (ch === "%") return "트"; // 퍼센트
  const latin = text.normalize("NFD").replace(/\p{M}/gu, "").match(/[A-Za-z]+$/)?.[0];
  if (!latin) return undefined;
  const letter = LETTER_READING[latin.at(-1)!.toUpperCase()];
  // A single letter or an all-capital run (r, PDF) is read letter by letter; any other run as a word.
  if (latin.length === 1 || latin === latin.toUpperCase()) return letter;
  const word = latin.toLowerCase();
  // shortcut: unmatched Latin endings use letter names; extend readings when a loanword differs.
  return WORD_ENDINGS.find(([ending]) => ending.test(word))?.[1] ?? letter;
}

/**
 * Whether the text before the particle takes the first form of `pair` (the form with batchim: 을, 이, 은, 과,
 * 으로, 아); undefined when its reading is unknown (punctuation, symbols).
 */
function takesFirst(text: string, pair: JosaPair): boolean | undefined {
  const syllable = reading(text.normalize("NFKC"));
  if (!syllable) return undefined;
  const final = (syllable.charCodeAt(0) - 0xac00) % 28;
  // 으로/로: a word ending in ㄹ (final index 8) takes 로, like a vowel ending.
  return pair === "으로로" ? final !== 0 && final !== 8 : final !== 0;
}

export function josa(word: string, pair: JosaPair): string {
  const [withBatchim, without] = PAIRS[pair];
  const trimmed = word.trim().normalize("NFKC");
  if (!trimmed) return word;
  let i = trimmed.length - 1;
  while (i >= 0 && isCloser(trimmed[i]!)) i--;
  const first = takesFirst(trimmed.slice(0, i + 1), pair);
  // Punctuation or symbol ending: show both forms rather than guess.
  if (first === undefined) return `${word}${withBatchim}(${without})`;
  return word + (first ? withBatchim : without);
}

/** The written-out fallbacks a message may carry (「X은(는)」, 「X(으)로」), each with its pair. */
const FALLBACK = /(은\(는\)|는\(은\)|을\(를\)|를\(을\)|이\(가\)|가\(이\)|과\(와\)|와\(과\)|\(으\)로|으로\(로\)|아\(야\)|야\(아\))/g;
const FALLBACK_PAIR: Record<string, JosaPair> = { "은(는)": "은는", "는(은)": "은는", "을(를)": "을를", "를(을)": "을를", "이(가)": "이가", "가(이)": "이가", "과(와)": "과와", "와(과)": "과와", "(으)로": "으로로", "으로(로)": "으로로", "아(야)": "아야", "야(아)": "아야" };

/**
 * Resolves the written-out fallbacks in formatted text (hire-37: 「입사일은(는)」, 「명부 가져오기(으)로」) to the one
 * particle the word before them takes, skipping back over a closing parenthesis or quote to find it. A word that does
 * not end in a recognizable syllable keeps both forms, as `josa` writes them.
 */
export function resolveJosa(text: string): string {
  if (!text.includes("(")) return text;
  return text.replace(FALLBACK, (written: string, _: string, at: number) => {
    let i = at - 1;
    while (i >= 0 && isCloser(text[i]!)) i--;
    const pair = FALLBACK_PAIR[written]!;
    const first = takesFirst(text.slice(0, i + 1), pair);
    if (first === undefined) return written;
    const [withBatchim, without] = PAIRS[pair];
    return first ? withBatchim : without;
  });
}

const TOKEN = /\{(\w+)\|(을를|이가|은는|과와|으로로|아야)\}/g;
/**
 * Resolves `{name|을를}` tokens to `{name}` + particle before ICU formatting. The value itself is
 * substituted by ICU, so names containing `{` or `'` stay literal and the format cache stays bounded.
 */
export function applyJosa(message: string, values: Record<string, unknown>): string {
  return message.replace(TOKEN, (_, key: string, pair: JosaPair) => {
    const word = String(values[key] ?? "");
    return `{${key}}${josa(word, pair).slice(word.length)}`;
  });
}
