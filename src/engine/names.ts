// E07 name comparison for record linkage across sources, scripts and romanizations.
// Pure functions only. The output is a `similarity` aid for a human identity decision; it never decides, merges or assesses.
//
// Method (language-neutral, script-aware):
//  1. Unicode NFKC, case folding, removal of combining marks, joiners and punctuation.
//  2. Arabic-script letters are folded to one form per letter (yeh, kaf, alef, teh marbuta and hamza variants) and then
//     transliterated into a Latin consonant skeleton, so a name written in Arabic script can be compared with its
//     romanizations. Latin names are reduced to the same skeleton with a small table of romanization equivalences
//     (kh/x, gh/q, sh, ch, zh, ph/f, w/v) and vowel removal. Deployments may add equivalences through configuration.
//  3. Similarity is the larger of a whole-name comparison and a token comparison (order-independent), each by
//     Jaro–Winkler on the skeleton. It is labelled `similarity` everywhere and carries no evidential weight.

/** Folds Arabic-script presentation variants to one letter each (applies to Arabic, Persian, Urdu, Kurdish and others). */
const ARABIC_FOLD: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ۍ': 'ی', 'ې': 'ی', 'ك': 'ک', 'ڪ': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'ہ': 'ه', 'ھ': 'ه', 'ە': 'ه',
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و', 'ۆ': 'و', 'ۇ': 'و', 'ۋ': 'و',
};
/** Arabic-script letter → Latin skeleton symbol. Vowel carriers (alef, waw, yeh, heh, ain) are dropped, as Latin vowels are. */
const ARABIC_LATIN: Record<string, string> = {
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's', 'ج': 'j', 'چ': 'C', 'ح': '', 'خ': 'x', 'د': 'd', 'ذ': 'z',
  'ر': 'r', 'ڕ': 'r', 'ز': 'z', 'ض': 'z', 'ظ': 'z', 'ژ': 'Z', 'ش': 'S', 'ع': '', 'غ': 'q', 'ق': 'q', 'ف': 'f', 'ڤ': 'v', 'ک': 'k', 'گ': 'g',
  'ل': 'l', 'ڵ': 'l', 'م': 'm', 'ن': 'n', 'و': '', 'ی': '', 'ه': '', 'ا': '', 'ء': '',
};
/** Common romanization equivalences, applied to lowercase ASCII before vowels are removed. Order matters. */
export const DEFAULT_LATIN_EQUIVALENCES: readonly (readonly [string, string])[] = [
  ['kh', 'x'], ['gh', 'q'], ['sh', 'S'], ['ch', 'C'], ['zh', 'Z'], ['ph', 'f'], ['dh', 'z'], ['th', 't'], ['w', 'v'], ['c', 'k'],
];
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export type NameOptions = Readonly<{ equivalences?: readonly (readonly [string, string])[] }>;

/** Display-preserving normalization: folded case, no marks, single spaces. Used for equality of attribute values too. */
export function foldText(s: string): string {
  return s.normalize('NFKC').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').replace(/ـ/g, '')
    .split('').map((ch) => ARABIC_FOLD[ch] ?? ch).join('')
    .normalize('NFD').replace(/[̀-ًͯ-ٰٟ]/g, '')
    .toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Splits "Mehdi (Khabat) Kakaei" into the name without the parenthesis and the parenthesised alternative name. */
export function nameVariants(name: string): string[] {
  const out = new Set<string>([name]);
  const m = /^(.*?)\(([^)]*)\)(.*)$/u.exec(name);
  if (m !== null) {
    const before = (m[1] as string).trim(), inner = (m[2] as string).trim(), after = (m[3] as string).trim();
    out.add(`${before} ${after}`.trim());
    // "(Khabat) Kakaei": the parenthesised word replaces the given name; keep the surname.
    if (inner !== '') out.add(`${inner} ${after}`.trim());
  }
  return [...out].filter((v) => v.trim() !== '');
}

function skeletonToken(token: string, eq: readonly (readonly [string, string])[]): string {
  let s: string;
  if (ARABIC_RANGE.test(token)) s = token.split('').map((ch) => ARABIC_LATIN[ch] ?? (/[a-z0-9]/.test(ch) ? ch : '')).join('');
  else {
    s = token.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [from, to] of eq) s = s.split(from).join(to);
    s = s.replace(/[aeiouyh']/g, '');
  }
  return s.replace(/v/g, '').replace(/(.)\1+/g, '$1');
}

export type NameKey = Readonly<{ folded: string; tokens: readonly string[]; skeleton: string }>;
/** Comparison key of one written name. */
export function nameKey(name: string, o: NameOptions = {}): NameKey {
  const eq = o.equivalences ?? DEFAULT_LATIN_EQUIVALENCES;
  const folded = foldText(name);
  const tokens = folded.split(' ').map((t) => skeletonToken(t, eq)).filter((t) => t !== '');
  return { folded, tokens, skeleton: tokens.join('') };
}

/** Jaro–Winkler similarity of two strings (0–1). */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  if (a === b) return a === '' ? 0 : 1;
  if (a === '' || b === '') return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false), bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = true; bm[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * prefixScale * (1 - jaro);
}

/** Order-independent token comparison: every token of the shorter name is matched to its best token in the longer one. */
function tokenScore(x: readonly string[], y: readonly string[]): number {
  if (x.length === 0 || y.length === 0) return 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const used = new Set<number>();
  let total = 0, weight = 0;
  for (const t of short) {
    let best = 0, at = -1;
    long.forEach((u, i) => { if (used.has(i)) return; const s = jaroWinkler(t, u); if (s > best) { best = s; at = i; } });
    if (at >= 0) used.add(at);
    // Longer tokens (usually family names) weigh more than short, frequent given names.
    total += best * t.length; weight += t.length;
  }
  // A name that is a strict subset of the other ("Mahan Mardani" ⊂ "Mohammad Mehdi Mahan Mardani") is penalised slightly.
  return (total / weight) * (0.9 + 0.1 * (short.length / long.length));
}

export function nameSimilarity(a: NameKey, b: NameKey): number {
  if (a.skeleton === '' || b.skeleton === '') return 0;
  // No prefix bonus on the whole name: a shared common given name at the start must not make two surnames look alike.
  const whole = jaroWinkler(a.skeleton, b.skeleton, 0);
  const tokens = tokenScore(a.tokens, b.tokens);
  return Math.round(Math.max(whole, tokens) * 1000) / 1000;
}

/** Best similarity over every written form (name, aliases, parenthesised variants) of two records. */
export function bestNameSimilarity(left: readonly NameKey[], right: readonly NameKey[]): { similarity: number; left: string; right: string } {
  let best = { similarity: 0, left: '', right: '' };
  for (const l of left) for (const r of right) {
    const s = nameSimilarity(l, r);
    if (s > best.similarity) best = { similarity: s, left: l.folded, right: r.folded };
  }
  return best;
}

/** Blocking keys: skeletons of tokens of at least two symbols. Records are compared only when they share a key. */
export function blockingKeys(keys: readonly NameKey[]): string[] {
  return [...new Set(keys.flatMap((k) => k.tokens.filter((t) => t.length >= 2)))];
}
