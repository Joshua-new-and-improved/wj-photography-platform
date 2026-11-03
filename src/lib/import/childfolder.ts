import { normaliseFolderName, isIgnorableName } from "./folders.js";

/**
 * Match a photograph to a child by the folder it sits in.
 *
 * The architecture's default matching path was slate cards (§7.3), with
 * manual tagging as the fallback when no cards exist. In practice, Wiaan's
 * real folder layout already carries the answer: each child gets their own
 * folder, named for the child, sitting under the class folder —
 *
 *     School/Grade/Class/Firstname Lastname/IMG_001.jpg
 *
 * Requiring a photographer to also print and shoot slate cards to get
 * automatic matching, when the folder structure already names the child, is
 * extra work for no reason. So this is a third matching path, ranked ahead of
 * manual tagging when it applies: if the file sits three folders below the
 * school (grade/class/child), the third folder's name IS the child.
 *
 * Deliberately conservative. A folder name that does not look like a person's
 * name — a stray "RAW", a re-shoot marker, a a bare number — returns null and
 * the file falls through to the existing manual-tagging queue rather than
 * silently becoming a "child" called "RAW" (§2.4's fail-visibly principle
 * applies here as much as it does to slate segmentation).
 */

export interface ParsedChildFolder {
  firstName: string;
  lastName: string;
  /** The exact folder text, kept for the review screen and for re-matching
   *  photographs added to the same folder later in the same shoot. */
  rawFolderName: string;
}

const NON_NAME_WORDS = new Set([
  "raw", "originals", "edited", "final", "export", "exports", "selects",
  "proofs", "backup", "temp", "tmp", "retakes", "retake", "absent",
  "absentees", "misc", "other", "others", "unsorted", "group", "groups",
  "class", "klas", "staff", "teachers", "personeel",
]);

export function parseChildFolder(rawSegment: string): ParsedChildFolder | null {
  const trimmed = rawSegment.trim();
  if (!trimmed) return null;
  if (isIgnorableName(trimmed)) return null;
  // A leading underscore/hash/tilde means "not a class or a child" by the same
  // convention as parseClass in folders.ts.
  if (/^[_#~]/.test(trimmed)) return null;

  const norm = normaliseFolderName(trimmed);
  if (!norm) return null;

  const words = norm.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return null; // implausible as a name
  if (words.some((w) => NON_NAME_WORDS.has(w))) return null;
  // Bare digits ("2024", "01") are never a child's name.
  if (words.every((w) => /^\d+$/.test(w))) return null;

  const titled = displayWords(trimmed, words);

  if (titled.length === 1) {
    // A single word is ambiguous — could be a first name, could be a class
    // colour ("Blou") that slipped through. Still usable, but flagged by the
    // caller as lower-confidence via the single-word shape.
    return { firstName: titled[0]!, lastName: "", rawFolderName: trimmed };
  }

  // The surname starts at the first surname particle ("van", "du", "le" …)
  // after the given name, otherwise it is the last word. "Zané du Toit" is
  // Zané / du Toit, "Anna Marie van Merwe" is Anna Marie / van Merwe, and
  // "Noah Botha" is Noah / Botha.
  let split = titled.length - 1;
  for (let i = 1; i < titled.length - 1; i++) {
    if (SURNAME_PARTICLES.has(words[i]!)) { split = i; break; }
  }
  const firstName = titled.slice(0, split).join(" ");
  const lastName = titled.slice(split).join(" ");
  return { firstName, lastName, rawFolderName: trimmed };
}

const SURNAME_PARTICLES = new Set(["van", "von", "du", "de", "der", "den", "le", "la", "ter", "ten"]);

/**
 * The words to STORE and SHOW, as opposed to the normalised words used for
 * matching. Accents survive (Zané, not Zane) and the photographer's own
 * capitalisation is kept ("du Toit", not "Du Toit"). Only a folder typed all
 * in one case gets title-cased. If the raw text doesn't line up word-for-word
 * with the normalised form (noise like "(2)" or "final" was stripped), fall
 * back to title-casing the normalised words.
 */
function displayWords(raw: string, normWords: string[]): string[] {
  const rawWords = raw.replace(/[_.]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const plain = (w: string) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aligned = rawWords.length === normWords.length && rawWords.every((w, i) => plain(w) === normWords[i]);
  if (!aligned) return normWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1));

  const letters = raw.replace(/[^\p{L}]/gu, "");
  const oneCase = letters === letters.toLowerCase() || letters === letters.toUpperCase();
  return oneCase
    ? rawWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    : rawWords;
}

/**
 * Given a file's relative path (school folder already stripped), decide
 * whether it sits in a child-named folder at grade/class/child depth.
 *
 * Returns null for anything else — a flatter layout, a file at the class
 * root, or a folder that does not parse as a name — so the caller can fall
 * back to manual tagging exactly as before.
 */
export function childFolderFromPath(innerSegments: string[]): ParsedChildFolder | null {
  // grade / class / child / file.jpg  → 3 folder segments before the file.
  if (innerSegments.length !== 3) return null;
  return parseChildFolder(innerSegments[2]!);
}
