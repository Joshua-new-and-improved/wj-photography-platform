/**
 * Print production planning and packing.
 *
 * The studio prints in house at the office after the order deadline closes,
 * then packs and delivers to the school for distribution. That produces two
 * different orderings of the same set of prints, and confusing them is the
 * difference between a smooth afternoon and a bad one:
 *
 *   PRINT ORDER — grouped by paper size and finish, so the printer loads A4
 *   gloss once and produces every A4 gloss print in the shoot. Interleaving
 *   sizes means a media change per order, which on a 400-print run is an hour
 *   of swapping paper.
 *
 *   PACK ORDER — grouped by class, then by child, because that is how the
 *   school office sorts the boxes and how a teacher hands them out. Sorting
 *   the delivery by order number would make the secretary's day considerably
 *   worse (§12.5).
 *
 * Pure functions, so the plan is reproducible and a disputed envelope can be
 * reconstructed from stored data months later.
 */

export interface PrintJob {
  id: string;
  orderId: string;
  orderNumber: string;
  childId: string;
  childFirstName: string;
  childLastName: string;
  gradeName: string;
  gradeLevel: string; // 'RR' | 'R' | '1'..'12'
  className: string;
  assetRef: string;
  sizeLabel: string;
  finish: string | null;
  quantity: number;
  status: "queued" | "printed" | "reprint_needed" | "superseded" | "packed";
  reprintOf?: string | null;
}

// ── Print runs ──────────────────────────────────────────────────────────────

export interface PrintRun {
  sizeLabel: string;
  finish: string | null;
  jobs: PrintJob[];
  /** Total sheets, i.e. quantities summed — not job count. */
  sheets: number;
  children: number;
}

/**
 * Group outstanding work into runs, heaviest first.
 *
 * Superseded jobs are excluded: a job replaced by a reprint must not be
 * printed again, and the commonest way that goes wrong is a plan built from
 * "everything in the batch" rather than "everything still outstanding".
 */
export function planPrintRuns(jobs: PrintJob[]): PrintRun[] {
  const outstanding = jobs.filter(
    (j) => j.status === "queued" || j.status === "reprint_needed",
  );

  const byMedia = new Map<string, PrintRun>();
  for (const j of outstanding) {
    const key = `${j.sizeLabel}\u0000${j.finish ?? ""}`;
    let run = byMedia.get(key);
    if (!run) {
      run = { sizeLabel: j.sizeLabel, finish: j.finish, jobs: [], sheets: 0, children: 0 };
      byMedia.set(key, run);
    }
    run.jobs.push(j);
    run.sheets += j.quantity;
  }

  for (const run of byMedia.values()) {
    run.children = new Set(run.jobs.map((j) => j.childId)).size;
    // Within a run, order by class then child — so that even though the run is
    // organised for the printer, the output tray comes off roughly in packing
    // order and the sorting afterwards is shorter.
    run.jobs.sort(comparePackOrder);
  }

  // Longest run first: the photographer loads the paper they will use most,
  // and the biggest chunk of the job is done before anything can go wrong.
  return [...byMedia.values()].sort((a, b) => b.sheets - a.sheets);
}

// ── Packing ─────────────────────────────────────────────────────────────────

export interface Envelope {
  childId: string;
  childName: string;
  orderNumbers: string[];
  items: Array<{ sizeLabel: string; finish: string | null; quantity: number; assetRef: string }>;
  totalPrints: number;
}

export interface ClassPack {
  gradeName: string;
  gradeLevel: string;
  className: string;
  envelopes: Envelope[];
  totalPrints: number;
}

export interface PackingManifest {
  classes: ClassPack[];
  totalEnvelopes: number;
  totalPrints: number;
  /** Jobs that are not ready to pack. Surfaced, never silently dropped. */
  outstanding: PrintJob[];
}

/**
 * Build the manifest the boxes get packed from.
 *
 * One envelope per child, not per order: a parent who ordered twice — a
 * package on Monday and an extra A4 on Thursday — gets one envelope, because
 * that is what a teacher hands over. The order numbers are both printed on it
 * so a query can be traced back.
 */
export function buildPackingManifest(jobs: PrintJob[]): PackingManifest {
  const ready = jobs.filter((j) => j.status === "printed" || j.status === "packed");
  const outstanding = jobs.filter(
    (j) => j.status === "queued" || j.status === "reprint_needed",
  );

  const byClass = new Map<string, ClassPack>();

  for (const j of ready) {
    const classKey = `${j.gradeLevel}\u0000${j.className}`;
    let pack = byClass.get(classKey);
    if (!pack) {
      pack = {
        gradeName: j.gradeName,
        gradeLevel: j.gradeLevel,
        className: j.className,
        envelopes: [],
        totalPrints: 0,
      };
      byClass.set(classKey, pack);
    }

    let env = pack.envelopes.find((e) => e.childId === j.childId);
    if (!env) {
      env = {
        childId: j.childId,
        childName: `${j.childFirstName} ${j.childLastName}`,
        orderNumbers: [],
        items: [],
        totalPrints: 0,
      };
      pack.envelopes.push(env);
    }

    if (!env.orderNumbers.includes(j.orderNumber)) env.orderNumbers.push(j.orderNumber);
    env.items.push({
      sizeLabel: j.sizeLabel,
      finish: j.finish,
      quantity: j.quantity,
      assetRef: j.assetRef,
    });
    env.totalPrints += j.quantity;
    pack.totalPrints += j.quantity;
  }

  for (const pack of byClass.values()) {
    // Alphabetical by surname: how a class list is printed, and how a teacher
    // finds a name.
    pack.envelopes.sort((a, b) => a.childName.localeCompare(b.childName, "en"));
  }

  const classes = [...byClass.values()].sort(compareClass);

  return {
    classes,
    totalEnvelopes: classes.reduce((n, c) => n + c.envelopes.length, 0),
    totalPrints: classes.reduce((n, c) => n + c.totalPrints, 0),
    outstanding,
  };
}

/** RR, then R, then 1–12. Sorting these as strings puts Grade 10 before Grade 2. */
export function gradeRank(level: string): number {
  return level === "RR" ? -2 : level === "R" ? -1 : Number(level);
}

function compareClass(a: ClassPack, b: ClassPack): number {
  const g = gradeRank(a.gradeLevel) - gradeRank(b.gradeLevel);
  return g !== 0 ? g : a.className.localeCompare(b.className, "en");
}

function comparePackOrder(a: PrintJob, b: PrintJob): number {
  const g = gradeRank(a.gradeLevel) - gradeRank(b.gradeLevel);
  if (g !== 0) return g;
  const c = a.className.localeCompare(b.className, "en");
  if (c !== 0) return c;
  return `${a.childLastName} ${a.childFirstName}`.localeCompare(
    `${b.childLastName} ${b.childFirstName}`,
    "en",
  );
}

/**
 * Is this shoot ready to deliver?
 *
 * A delivery that arrives at the school one envelope short generates a phone
 * call, a special trip, and a parent who tells other parents. Better to hold
 * the whole delivery than to send it incomplete, so this returns a blocking
 * answer rather than a warning.
 */
export function deliveryReadiness(jobs: PrintJob[]): {
  ready: boolean;
  blocking: string[];
} {
  const blocking: string[] = [];

  const queued = jobs.filter((j) => j.status === "queued").length;
  if (queued > 0) blocking.push(`${queued} print(s) still queued`);

  const reprints = jobs.filter((j) => j.status === "reprint_needed").length;
  if (reprints > 0) blocking.push(`${reprints} print(s) waiting on a reprint`);

  return { ready: blocking.length === 0, blocking };
}
