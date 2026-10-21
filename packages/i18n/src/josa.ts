/**
 * Korean particles depend on whether the preceding word ends in a final consonant (받침).
 * Catalog messages write `{name|을를}`; the formatter appends the right particle to the value.
 */
const PAIRS = { 을를: ["을", "를"], 이가: ["이", "가"], 은는: ["은", "는"], 과와: ["과", "와"], 으로로: ["으로", "로"], 아야: ["아", "야"] } as const;
export type JosaPair = keyof typeof PAIRS;

/** Whether a Hangul syllable takes the first form of `pair`; undefined for anything else (digits, Latin). */
function takesFirst(ch: string | undefined, pair: JosaPair): boolean | undefined {
  const code = ch?.charCodeAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return undefined;
  const final = (code - 0xac00) % 28;
  // 으로/로: a word ending in ㄹ (final index 8) takes 로, like a vowel ending.
  return pair === "으로로" ? final !== 0 && final !== 8 : final !== 0;
}

export function josa(word: string, pair: JosaPair): string {
  const [withBatchim, without] = PAIRS[pair];
  const trimmed = word.trim();
  if (!trimmed) return word;
  const first = takesFirst(trimmed.at(-1), pair);
  // Not a Hangul syllable (digits, Latin): show both forms rather than guess.
  if (first === undefined) return `${word}${withBatchim}(${without})`;
  return word + (first ? withBatchim : without);
}

/** The written-out fallbacks a message may carry (「X은(는)」, 「X(으)로」), each with its pair. */
const FALLBACK = /(은\(는\)|는\(은\)|을\(를\)|를\(을\)|이\(가\)|가\(이\)|과\(와\)|와\(과\)|\(으\)로)/g;
const FALLBACK_PAIR: Record<string, JosaPair> = { "은(는)": "은는", "는(은)": "은는", "을(를)": "을를", "를(을)": "을를", "이(가)": "이가", "가(이)": "이가", "과(와)": "과와", "와(과)": "과와", "(으)로": "으로로" };
/** Closing marks a particle may follow: a parenthesis, a quote or a bracket closes the word it belongs to. */
const CLOSERS = new Set([")", "」", "』", "”", "’", '"', "'", "]", "》", "〉"]);

/**
 * Resolves the written-out fallbacks in formatted text (hire-37: 「입사일은(는)」, 「명부 가져오기(으)로」) to the one
 * particle the word before them takes, skipping back over a closing parenthesis or quote to find it. A word that does
 * not end in Hangul keeps both forms, as `josa` writes them.
 */
export function resolveJosa(text: string): string {
  if (!text.includes("(")) return text;
  return text.replace(FALLBACK, (written: string, _: string, at: number) => {
    let i = at - 1;
    while (i >= 0 && CLOSERS.has(text[i]!)) i--;
    const pair = FALLBACK_PAIR[written]!;
    const first = takesFirst(text[i], pair);
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
