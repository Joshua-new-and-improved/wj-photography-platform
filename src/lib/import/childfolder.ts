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

  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1));

  if (titled.length === 1) {
    // A single word is ambiguous — could be a first name, could be a class
    // colour ("Blou") that slipped through. Still usable, but flagged by the
    // caller as lower-confidence via the single-word shape.
    return { firstName: titled[0]!, lastName: "", rawFolderName: trimmed };
  }

  // "Firstname Lastname" is the overwhelmingly common shape. For three or
  // four words ("Anna Marie Van Der Merwe"), the LAST word is the surname
  // and everything before it is the given name — matching how South African
  // double-barrelled surnames are almost never the pattern (compound GIVEN
  // names are common; "Van Der Merwe" as a folder name would be unusual
  // without a first name attached, and if it happens, it still resolves to
  // *some* surname, which is recoverable in the review screen).
  const lastName = titled[titled.length - 1]!;
  const firstName = titled.slice(0, -1).join(" ");
  return { firstName, lastName, rawFolderName: trimmed };
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
