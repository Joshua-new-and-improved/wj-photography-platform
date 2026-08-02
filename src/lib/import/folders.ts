/**
 * Folder structure inference.
 *
 * The photographer drags a school folder in. The browser reports a relative
 * path per file. This module turns those paths into a *proposal* — never a
 * commit (architecture §2.8, §7.2).
 *
 * The hard part is not parsing. It is that folder names in the wild are
 * `Gr R A`, `GraadR-A`, `Grade R (Ms Botha)`, `graad r - a FINAL v2`, and
 * `Klas B kopie`. A typo silently creates a duplicate class and 400
 * photographs land in a gallery nobody can find. So every inference carries a
 * confidence, and anything below certainty surfaces on the review screen.
 */

/** Afrikaans and English are both first-class (§2.12), including in filenames. */
const GRADE_WORDS = ["grade", "graad", "gr", "g"];
const CLASS_WORDS = ["class", "klas", "cls", "kl"];

/**
 * Reception-year labels. South African schools use Grade R almost universally
 * and Grade RR (the year before) commonly in Gauteng, alongside older words
 * like "Reception" and Afrikaans "Graad R". Getting RR wrong merges two whole
 * year groups, so it is matched before R.
 */
const RECEPTION_ALIASES: Array<[RegExp, string]> = [
  [/^(rr|graadrr|graderr|receptionyear2|gradedoubler)$/, "RR"],
  [/^(r|graadr|grader|reception|rec|kleuters|gradezero|grade0|graad0|0)$/, "R"],
];

/**
 * Folders and files that are never structural. Present on essentially every
 * real upload; treating `__MACOSX` as a grade would be a memorable bug.
 */
const IGNORABLE = [
  /^\.\w/, // dotfiles
  /^__macosx$/,
  /^\.ds_store$/,
  /^thumbs\.db$/,
  /^desktop\.ini$/,
  /^(originals?|raw|edited|final|export|exports|selects|proofs|backup|temp|tmp)$/,
];

/** Editing detritus that should be stripped before matching, not treated as part of the name. */
const NOISE = [
  /\bfinal\b/g,
  /\bv\d+\b/g,
  /\bcop(y|ie)\b/g,
  /\bkopie\b/g,
  /\bnew\b/g,
  /\bnuwe\b/g,
  /\bdone\b/g,
  /\(\s*\d+\s*\)/g,
];

/**
 * Fold a raw folder name to a comparable form.
 *
 * Strips diacritics (SA names carry them constantly), lowercases, removes
 * parenthesised asides — `Grade R (Ms Botha)` is still Grade R when the teacher
 * changes — drops editing noise, and collapses everything else to spaces.
 */
export function normaliseFolderName(raw: string): string {
  let s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ");
  for (const n of NOISE) s = s.replace(n, " ");
  return s
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Same, with spaces removed — for comparing `GraadR` against `Graad R`. */
export function compactName(raw: string): string {
  return normaliseFolderName(raw).replace(/\s/g, "");
}

export function isIgnorableName(raw: string): boolean {
  const n = raw.trim().toLowerCase();
  return IGNORABLE.some((re) => re.test(n));
}

export interface GradeParse {
  /** Canonical level: 'RR', 'R', or '1'–'12'. */
  level: string;
  /** Canonical display name, e.g. 'Grade R'. */
  canonical: string;
  confidence: number;
}

/**
 * Parse a grade from a folder segment.
 *
 * Returns null rather than guessing. A folder called `_RETAKES` is not grade
 * zero, and pretending otherwise is worse than surfacing it for review.
 */
export function parseGrade(raw: string): GradeParse | null {
  const compact = compactName(raw);
  if (!compact) return null;

  for (const [re, level] of RECEPTION_ALIASES) {
    if (re.test(compact)) {
      return { level, canonical: `Grade ${level}`, confidence: 1 };
    }
  }

  // `grade7`, `graad 7`, `gr7`, `g7`, or a bare `7`.
  const m = compact.match(/^(grade|graad|gr|g)?(\d{1,2})$/);
  if (m) {
    const n = Number(m[2]);
    if (n >= 1 && n <= 12) {
      return {
        level: String(n),
        canonical: `Grade ${n}`,
        // A bare number is more ambiguous than an explicitly worded one — it
        // could be a class, a session number, or a camera batch.
        confidence: m[1] ? 1 : 0.6,
      };
    }
  }

  // `graadr`, `grr` — a grade word immediately followed by a reception alias.
  const worded = compact.match(/^(grade|graad|gr|g)(rr|r)$/);
  if (worded) {
    const level = worded[2]!.toUpperCase();
    return { level, canonical: `Grade ${level}`, confidence: 1 };
  }

  return null;
}

export interface ClassParse {
  name: string;
  canonical: string;
  confidence: number;
}

/**
 * Words that name an operational bucket, not a class.
 *
 * Every real shoot produces some of these. Treating `_RETAKES` as a class
 * called "Retakes" is worse than surfacing it, because it looks plausible on
 * the review screen and gets waved through.
 */
const NON_CLASS_WORDS = new Set([
  "retakes", "retake", "herneem", "herneems",
  "absent", "absentees", "afwesig", "afwesiges",
  "group", "groups", "groep", "groepe", "klasfotos", "klasfoto",
  "staff", "teachers", "personeel", "onderwysers",
  "misc", "other", "others", "ander", "unsorted", "losse",
  "siblings", "boeties", "sussies", "familie", "family",
]);

/** Parse a class label: `Klas A`, `Class A`, `A`, `1A`, `Blou`. */
export function parseClass(raw: string): ClassParse | null {
  // Photographers prefix an underscore or hash to sort a folder to the top of
  // the list. It reliably means "this is not one of the classes".
  if (/^[_#~]/.test(raw.trim())) return null;

  const norm = normaliseFolderName(raw);
  if (!norm) return null;
  if (NON_CLASS_WORDS.has(norm.replace(/\s/g, ""))) return null;

  const tokens = norm.split(" ");
  const first = tokens[0]!;

  // Explicit class word: `Klas A` → A.
  if (CLASS_WORDS.includes(first) && tokens.length > 1) {
    const label = tokens.slice(1).join(" ");
    return { name: label.toUpperCase(), canonical: label.toUpperCase(), confidence: 1 };
  }

  // Bare single letter — overwhelmingly the common case.
  if (/^[a-z]$/.test(norm)) {
    return { name: norm.toUpperCase(), canonical: norm.toUpperCase(), confidence: 0.95 };
  }

  // Colour or animal names, which Afrikaans crèches use constantly
  // (`Blou`, `Rooi`, `Sonnetjies`). Not parseable to a letter, so keep verbatim.
  if (/^[a-z]{2,20}$/.test(norm) && !GRADE_WORDS.includes(first)) {
    const titled = norm.charAt(0).toUpperCase() + norm.slice(1);
    return { name: titled, canonical: titled, confidence: 0.7 };
  }

  return null;
}

/**
 * Parse a segment that carries both, e.g. `Graad R - A` or `Gr 1 Klas B`.
 * Common when the photographer flattens the tree by one level.
 */
export function parseCombined(
  raw: string,
): { grade: GradeParse; klass: ClassParse } | null {
  const norm = normaliseFolderName(raw);
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length < 2) return null;

  // Try every split point, preferring the longest grade prefix that parses.
  for (let i = tokens.length - 1; i >= 1; i--) {
    const grade = parseGrade(tokens.slice(0, i).join(" "));
    if (!grade) continue;
    const klass = parseClass(tokens.slice(i).join(" "));
    if (!klass) continue;
    return {
      grade,
      // A combined segment is a shade less certain than two explicit levels.
      klass: { ...klass, confidence: Math.min(klass.confidence, 0.9) },
    };
  }
  return null;
}

// ── Fuzzy matching against existing records ─────────────────────────────────

/** Levenshtein distance, iterative two-row. Names here are short. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Reduce a folder name to a comparable domain key.
 *
 * `Graad R - A`, `Grade R A` and `grade-r/klas a` all collapse to `Grade R|A`.
 * This is what makes matching work across languages and layouts.
 */
export function canonicalKey(raw: string): string {
  const combined = parseCombined(raw);
  if (combined) return `${combined.grade.canonical}|${combined.klass.canonical}`;
  const g = parseGrade(raw);
  if (g) return g.canonical;
  const c = parseClass(raw);
  if (c) return c.canonical;
  return normaliseFolderName(raw);
}

/**
 * Structural similarity, not string distance.
 *
 * Plain Levenshtein is actively dangerous here. `Grade 2 A` and `Grade 1 A`
 * differ by one character and score 0.86; `Graad R A` and `Grade R A` — the
 * same class in two languages — differ by two and score 0.71. Any threshold
 * that accepts the correct match also accepts mixing two year groups.
 *
 * So: canonicalise first, and treat differing digits as disqualifying. Grade
 * numbers are exact facts, not fuzzy ones.
 */
export function similarity(a: string, b: string): number {
  const ka = canonicalKey(a);
  const kb = canonicalKey(b);

  const digitsA = (ka.match(/\d+/g) ?? []).join(",");
  const digitsB = (kb.match(/\d+/g) ?? []).join(",");
  if (digitsA !== digitsB) return 0;

  const x = compactName(ka);
  const y = compactName(kb);
  if (!x && !y) return 1;
  const max = Math.max(x.length, y.length);
  return max === 0 ? 1 : 1 - levenshtein(x, y) / max;
}

export interface FuzzyMatch<T> {
  candidate: T;
  score: number;
}

/**
 * Suggest an existing record for an inferred name.
 *
 * Deliberately returns a *suggestion*, never an automatic bind. The threshold
 * is set so that `Graad R-A` finds `Grade R A` but `Grade 1 A` does not find
 * `Grade 2 A` — the second mistake would silently mix two year groups.
 */
export function bestMatch<T>(
  needle: string,
  candidates: T[],
  nameOf: (c: T) => string,
  threshold = 0.72,
): FuzzyMatch<T> | null {
  let best: FuzzyMatch<T> | null = null;
  for (const c of candidates) {
    const score = similarity(needle, nameOf(c));
    if (score >= threshold && (!best || score > best.score)) {
      best = { candidate: c, score };
    }
  }
  return best;
}

// ── Tree proposal ───────────────────────────────────────────────────────────

export interface UploadedFile {
  /** Relative path as reported by the browser, e.g. `School ABC/Graad R/Klas A/IMG_1.jpg`. */
  relativePath: string;
  size: number;
}

export type NodeIssue =
  | "unrecognised_folder"
  | "bare_number_grade"
  | "ambiguous_class"
  | "flat_structure"
  | "files_at_root"
  | "no_grade_found";

export interface ProposedClass {
  rawName: string;
  canonical: string;
  fileCount: number;
  confidence: number;
  issues: NodeIssue[];
}

export interface ProposedGrade {
  rawName: string;
  canonical: string;
  level: string;
  confidence: number;
  classes: ProposedClass[];
  issues: NodeIssue[];
}

export interface ImportProposal {
  schoolName: string;
  grades: ProposedGrade[];
  /** Paths that could not be placed. Surfaced for manual assignment (§7.2). */
  unplaced: Array<{ path: string; reason: NodeIssue }>;
  ignored: string[];
  fileCount: number;
  /** True when every node parsed cleanly — the one-click case. */
  cleanParse: boolean;
}

const IMAGE_EXT = /\.(jpe?g|png|tiff?|heic|webp|dng|cr2|cr3|nef|arw|raf|orf)$/i;

/**
 * Build a proposal from a set of uploaded relative paths.
 *
 * Handles the three shapes seen in practice:
 *   School/Grade/Class/file.jpg     — the documented layout
 *   School/Grade - Class/file.jpg   — flattened by one level
 *   School/Class/file.jpg           — crèches with no grade tier
 */
export function proposeStructure(files: UploadedFile[]): ImportProposal {
  const gradeMap = new Map<string, ProposedGrade>();
  const unplaced: ImportProposal["unplaced"] = [];
  const ignored: string[] = [];
  let schoolName = "";
  let fileCount = 0;

  for (const f of files) {
    const segments = f.relativePath.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName || !IMAGE_EXT.test(fileName)) {
      ignored.push(f.relativePath);
      continue;
    }
    if (segments.some(isIgnorableName) || isIgnorableName(fileName)) {
      ignored.push(f.relativePath);
      continue;
    }

    fileCount++;
    if (!schoolName && segments.length > 0) schoolName = segments[0]!;

    const inner = segments.slice(1); // everything below the school folder

    if (inner.length === 0) {
      unplaced.push({ path: f.relativePath, reason: "files_at_root" });
      continue;
    }

    let grade: GradeParse | null = null;
    let klass: ClassParse | null = null;
    let issues: NodeIssue[] = [];
    let gradeRaw = "";
    let classRaw = "";

    if (inner.length >= 2) {
      gradeRaw = inner[0]!;
      classRaw = inner[inner.length - 1]!;
      grade = parseGrade(gradeRaw);
      klass = parseClass(classRaw);
    }

    // Flattened: a single level carrying both.
    if (!grade && inner.length >= 1) {
      const combined = parseCombined(inner[0]!);
      if (combined) {
        gradeRaw = inner[0]!;
        classRaw = inner[0]!;
        grade = combined.grade;
        klass = combined.klass;
        issues.push("flat_structure");
      }
    }

    // Crèche shape: one level, class only, no grade tier.
    if (!grade && inner.length === 1) {
      const only = parseClass(inner[0]!);
      if (only) {
        gradeRaw = "";
        classRaw = inner[0]!;
        grade = { level: "R", canonical: "Grade R", confidence: 0.4 };
        klass = only;
        issues.push("no_grade_found");
      }
    }

    if (!grade || !klass) {
      unplaced.push({ path: f.relativePath, reason: "unrecognised_folder" });
      continue;
    }

    if (grade.confidence < 1) issues.push("bare_number_grade");
    if (klass.confidence < 0.9) issues.push("ambiguous_class");

    const key = grade.level;
    let node = gradeMap.get(key);
    if (!node) {
      node = {
        rawName: gradeRaw || grade.canonical,
        canonical: grade.canonical,
        level: grade.level,
        confidence: grade.confidence,
        classes: [],
        issues: [],
      };
      gradeMap.set(key, node);
    }

    let cls = node.classes.find((c) => c.canonical === klass!.canonical);
    if (!cls) {
      cls = {
        rawName: classRaw,
        canonical: klass.canonical,
        fileCount: 0,
        confidence: klass.confidence,
        issues: [],
      };
      node.classes.push(cls);
    }
    cls.fileCount++;
    for (const i of issues) {
      if (!cls.issues.includes(i)) cls.issues.push(i);
    }
  }

  const grades = [...gradeMap.values()].sort(gradeOrder);
  for (const g of grades) g.classes.sort((a, b) => a.canonical.localeCompare(b.canonical));

  return {
    schoolName,
    grades,
    unplaced,
    ignored,
    fileCount,
    cleanParse:
      unplaced.length === 0 &&
      grades.length > 0 &&
      grades.every(
        (g) => g.confidence === 1 && g.classes.every((c) => c.issues.length === 0),
      ),
  };
}

/** RR, then R, then 1–12. Sorting these as strings puts Grade 10 before Grade 2. */
function gradeOrder(a: ProposedGrade, b: ProposedGrade): number {
  const rank = (l: string) => (l === "RR" ? -2 : l === "R" ? -1 : Number(l));
  return rank(a.level) - rank(b.level);
}
