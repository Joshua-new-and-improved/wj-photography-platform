# School Photography Platform

Commercial platform for a professional school photography business: folder
import, per-child galleries, secure parent access, packages and ordering.

**Architecture:** see `school-photography-platform-architecture.md` (Phase 0).
Section references throughout the code (`§6.2`, `§12.1`) point at that document.

**Current phase:** 3 of 7 — access and the parent gallery. Claim service complete; prototype in `parent-gallery-prototype.html`.

---

## Phase 3 report — access and the parent gallery

### What was built

`src/lib/claim.ts` — issue, redeem, complete and revoke, with Argon2id hashing
and rate limiting. Plus a clickable prototype of the parent experience
(`parent-gallery-prototype.html`) built to the Contact Sheet direction in §18.

### Decisions worth defending

**Argon2id for claim codes, SHA-256 for session tokens.** Not inconsistency.
A claim code has ~50 bits from a 32-symbol alphabet — ample against a rate
limiter, not ample against an offline attack on a leaked database, which is
precisely what a slow hash is for. A session token is 256 random bits; there is
nothing to brute-force, so a slow hash would buy latency and nothing else.
Parameters are OWASP's floor for Argon2id (19 MiB, t=2), asserted in the test
suite so a future "performance fix" has to argue with a failing test.

**Salting has a real cost, taken deliberately.** Per-row salts mean redemption
cannot look a code up by hash; every live candidate for the shoot is verified in
turn. Acceptable at a few hundred codes per shoot, and the shoot comes from the
QR URL rather than being guessed. If a shoot ever exceeds a few thousand live
codes, the fix is a keyed lookup index (HMAC under a server-side pepper)
*alongside* the Argon2 hash — never weakening the hash.

**"Already used" is deliberately distinguishable from "no such code."** Every
other failure returns one generic message, because distinguishing malformed
from unknown would let an attacker confirm which prefixes exist and shrink a
50-bit search. But `already_redeemed` is different: if a slip was intercepted,
that message is what tells the real parent something is wrong, and it is the
signal that brings them to the studio. Concealing it protects the attacker.

**Claim completion is one transaction.** A binding without a burned code lets
the slip be reused; a burned code without a binding locks the parent out with no
way back but a support call. The burn is a conditional `UPDATE ... WHERE
redeemed_at IS NULL` returning rows, so two parents scanning the same QR in the
same second produce exactly one winner.

### The prototype

Open `parent-gallery-prototype.html` in a browser. It is a front-end sketch with
no backend, and it makes four architectural decisions visible rather than
described:

- **The watermark is tiled across the whole frame**, in the grid and in the
  lightbox. Not a corner logo — a corner logo is cropped out in four seconds.
- **The gallery renders before any account exists** (§6.3). The login wall sits
  at checkout, not in front of the child's face.
- **Favourites come before prices** (§9). Marking a photo is a red chinagraph
  circle, drawn in one stroke, wobbled differently for every frame — the point
  of a chinagraph pencil is that it is a hand, not a stamp.
- **Afrikaans is the default**, with an EN toggle. The reference material is an
  Afrikaans slip from an Afrikaans-medium school.

The sibling switcher shows the many-to-many model: the class and family photos
carry the same asset id under both children, which is the thing a folder tree
cannot express.

**The imagery is abstract placeholders.** Generating pictures of children —
even synthetic ones — to demo a product about photographs of children is not
worth doing. The placeholders are studio-backdrop gradients with abstract
figures: enough to judge composition, spacing and weight, and nothing more.

### Not built yet

OTP sign-in, the consent screen, QR and card-sheet PDF generation, and wiring
the prototype to the API. The prototype is a sketch to argue with, not a
front end to ship.

---

## Phase 2 report — ingestion

Assumptions taken from the Phase 1 recommendations, since they were not
overridden: **`af-south-1` hosting**, **slate cards as the primary matching
path** with manual tagging as a full fallback, and **a single studio** (the
schema carries `studio_id` regardless, so this is reversible).

### What was built

| Area | Delivered |
|---|---|
| Folder inference | Afrikaans/English normalisation, grade and class parsing, structural fuzzy matching, three-layout tree proposal |
| Slate segmentation | Capture-time segmentation with eight named failure modes and a confidence per assignment |
| Media pipeline | Variant ladder, tiled watermark, EXIF/GPS stripping, decompression-bomb guard, perceptual hashing |
| EXIF | A bounded, hand-rolled TIFF/IFD reader |
| Schema | Migration 0009: resumable upload sessions, per-file staging, review queue, slate decode outcomes |
| Tests | 46 unit + 80 database assertions, all green |

The media pipeline was exercised against real image bytes through libvips
8.18.3, not mocked.

### Three things that came out differently than planned

**1. Levenshtein distance is actively dangerous for this domain.** The
architecture proposed trigram similarity for matching an imported folder name
against existing classes. Built and measured, it does the opposite of what is
wanted: `Grade 2 A` and `Grade 1 A` differ by one character and score **0.86**,
while `Graad R A` and `Grade R A` — the same class in two languages — differ by
two and score **0.71**. Any threshold that accepts the correct match also
accepts silently merging two year groups.

The fix is structural rather than textual. Both sides are canonicalised through
the grade and class parsers first (`Graad R - A` and `Grade R A` both become
`Grade R|A`), and differing digits score zero regardless of string similarity.
Grade numbers are exact facts, not fuzzy ones. This is in `folders.ts` with the
reasoning attached, because the naive version looks correct and passes a casual
review.

**2. `_RETAKES` parsed as a class called "Retakes".** The crèche fallback —
which exists so that a pre-school with classes named *Blou* and *Sonnetjies*
still works — happily accepted every operational bucket folder. Worse than an
error: it looks plausible on the review screen and gets waved through. Now a
leading `_`, `#` or `~` disqualifies a folder outright (photographers use that
prefix precisely to mean "not one of the classes"), backed by a word list
covering both languages: *retakes/herneem*, *absent/afwesig*,
*staff/personeel*, *siblings/boeties*.

**3. Pattern-matching bytes cannot find an EXIF tag.** GPS detection started as
a scan for the byte pair `0x88 0x25` anywhere in the EXIF block. It reported
`false` on a file that demonstrably carried location data, and would report
`true` on any file whose pixel-adjacent bytes happened to contain that pair.
Replaced with a real TIFF walk: byte-order detection, IFD0 traversal, ExifIFD
descent, every offset bounds-checked and the recursion depth capped. Hand-rolled
rather than pulled from a dependency — this runs on the least trusted input in
the system, and a general-purpose EXIF library is a much larger attack surface
for four fields.

### Slate segmentation, and why it fails loudly

The mechanism replacing facial recognition (§7.3) is a pure function: frames
ordered by EXIF capture time, everything between slate *n* and slate *n+1*
belongs to child *n*. What makes it usable in production is not the happy path
but the eight ways it announces trouble:

`oversized_segment` (a card was missed, so two children's frames merged),
`suspicious_gap` (a long pause mid-sequence — the same failure, caught by
timing instead of volume), `empty_segment` (card shot, child gone — correlates
with the absentee list), `unknown_slate_code` (a card from another school, or a
class list that changed after printing), `duplicate_slate` (a legitimate retake,
merged but flagged), `frames_before_first_slate`, `missing_capture_time`, and
`no_slates_found` — which degrades cleanly to manual tagging rather than
failing.

This is the whole argument against the probabilistic alternative. A matcher
that is 97% accurate puts roughly six hundred photographs a year in the wrong
gallery at the volumes in §A7, and nobody finds out until a parent does. This
one produces a review queue.

One behaviour changed during testing: a duplicated slate code was initially
flagged only on its second occurrence, leaving the earlier frames at full
confidence. But the question a duplicate raises — *are these really the same
child?* — is not answered differently for the earlier frames. All segments for
an affected code are now downgraded together.

### Media pipeline

Measured on a 7.6 MB, 4000×6000 source, against the §8.3 budgets:

| Variant | Dimensions | AVIF | WebP | Budget |
|---|---|---|---|---|
| thumb | 267×400 | 2.0 KB | 1.2 KB | 25 KB |
| preview | 800×1200 | 10.8 KB | 5.5 KB | 120 KB |
| proof | 1365×2048 | — | 11.2 KB | 300 KB |
| print | 4000×6000 | — | 7.8 MB (JPEG q95) | — |

**Read those with caution.** The test fixture is a synthetic gradient with fine
noise, not a photograph — real portraits carry skin texture, hair and fabric
detail that compress considerably worse. The budgets are enforced in CI and the
headroom is real, but these particular numbers are optimistic. Re-measure
against a batch of the photographer's own files before treating them as a
baseline.

Two guarantees are asserted rather than assumed. **GPS never survives
derivation** — sharp discards metadata by default, which means adding
`.withMetadata()` to preserve a copyright field would quietly put the
coordinates of a primary school back onto a public URL; the test checks every
variant of every format. And **the watermark actually moves pixels**: the test
composites a marked and an unmarked derivative and counts differing pixels,
because a watermark that is recorded in the database but not composited into
the image is worse than none at all, since everyone downstream believes it is
there.

### Trade-offs taken knowingly

**The inference layer is pure functions with no database access.** Every
decision is replayable from stored metadata months later, when a parent
disputes an assignment. The cost is that fuzzy matching against existing classes
happens in application memory rather than as a `pg_trgm` query — fine at a few
hundred classes per school, and revisitable if it ever isn't.

**The tree proposal is deliberately conservative.** A crèche folder with no
grade tier is placed at confidence 0.4 and flagged, rather than either rejected
or silently accepted. It will annoy a photographer whose crèches always look
like that. The alternative annoys a parent whose child's photographs cannot be
found, which is the more expensive mistake.

**Vitest's default 5-second timeout was raised to 60.** A 24 MP source through
an AVIF encoder is seconds of genuine work. The alternative — shrinking fixtures
until they fit the timeout — would have made the weight budgets meaningless.

### Not built yet

The upload UI (`webkitdirectory`, presigned multipart, IndexedDB resumption),
the review screen, the barcode decoder binding, the tagging interface, and the
worker that wires these pieces to the queue. The logic they depend on is done
and tested; what remains is plumbing and interface, which is Phase 2's second
half and needs the hosting decision to be real.

---

## Phase 1 report

The brief asks for an explanation of what was built, the architectural
decisions, and the trade-offs at the end of each phase. This is that.

### What was built

| Area | Delivered |
|---|---|
| Schema | 35 tables across 8 migrations: tenancy, organisation, children, access, media, commerce, audit |
| Security | 79 row-level security policies; RLS enabled **and forced** on every table |
| Audit | Hash-chained, append-only event log with a verification function |
| Identity | Crockford base32 claim codes and order numbers; UUIDv7 keys; 128-bit public references |
| Application | Enforced session-context database client; typed audit writer; i18n resolution |
| Tests | 65 database assertions, 12 unit tests, both wired into CI |
| CI | Migrations applied to a clean PostgreSQL 16 on every push, plus two structural guards |

Every migration and every assertion in this repository was executed against a
real PostgreSQL 16.14 instance during development. Nothing here is asserted
without having been run.

### The decisions worth defending

**1. RLS is the second layer, not the first — and the application connects as a
non-owner.** The application's repository layer scopes queries by tenant. The
policies are there for the day it doesn't. This only works because `app_rw` is
neither the table owner nor `BYPASSRLS`; connecting as the owner would disable
all 79 policies and *nothing would fail visibly*. `FORCE ROW LEVEL SECURITY` is
set as well, so even an owner connection stays constrained.

**2. The tests run as the application's own role.** Asserting isolation as a
superuser asserts nothing. `db/test/02_rls.sql` runs `set role app_rw` and then
proves, with real queries, that a guardian bound to one child cannot see
another child's portrait, cannot see any unwatermarked variant, and cannot see a
suppressed child at all — while *both* guardians can see the class photograph
they share. That last one is the many-to-many model from §2.3 working.

**3. Rules that matter are enforced by the database.** "The code will remember
to check" is not a control. So: a shoot cannot open at a school with no signed
processing agreement; an order cannot enter production unpaid unless an offline
payment is recorded; a suppressed child cannot acquire a gallery item or a claim
code; an unwatermarked preview-class variant cannot be created at all; an active
admin cannot exist without MFA. Each is a trigger or constraint with a test.

**4. Claim codes are hashed like passwords.** They have ~50 bits of entropy,
which is plenty against a rate limiter but not against an offline attack on a
leaked database. Argon2id, with only a three-character hint stored for support
calls. Session tokens get SHA-256 instead — they are 256 random bits, so there
is nothing to brute-force and a slow hash would only cost latency. Using one
primitive for both would be wrong in one direction or the other.

**5. The audit chain survives a privileged attacker.** Privilege revocation
stops `app_rw` from updating or deleting. Triggers stop the owner. And the hash
chain catches an edit made with the triggers disabled — which the test suite
demonstrates by disabling them, editing a row, and asserting that
`app.audit_verify` names the exact tampered sequence number.

### Trade-offs taken knowingly

**SQL is the source of truth; Drizzle types are introspected from it.** This is
backwards from the usual Drizzle workflow. RLS policies, hash-chain triggers,
generated `tsvector` columns and partial indexes have no faithful representation
in a TypeScript schema DSL. Making TypeScript authoritative would mean either
losing them or maintaining parallel hand-written migrations that drift — and
drift in an RLS policy is a security bug that typechecks cleanly. The cost is
that schema changes are two steps instead of one.

**A hand-rolled test harness instead of pgTAP.** pgTAP is better, but it is an
extension that has to be present in the CI service container, on every
developer's machine, and in any managed database used for testing. The harness
is forty lines of plain SQL that runs anywhere `psql` does. The test bodies are
written so that only the assertion calls change when the suite outgrows it.

**A transaction-scoped advisory lock serialises audit appends.** It is a
serialisation point on a write path. At this system's volume that is free, and
the alternative is a chain with races in it, which is not a chain.

**`app.uuidv7()` is a shim.** PostgreSQL 18 ships this natively. Targeting 16
means carrying forty lines of bit manipulation that will be deleted on upgrade.
Worth it: UUIDv4 primary keys fragment the B-tree across ~160k asset inserts a
year, and that is not fixable later without rewriting every key.

### What CI catches that a human would not

Two structural guards, both of which found something real during development:

- **Every table has RLS enabled and forced.** The realistic failure is not
  writing a bad policy, it is forgetting a table.
- **Every table has at least one policy.** A table with RLS on and no policy is
  deny-all: the application gets empty result sets, not errors. This check
  caught the missing `studio` policy, which would have shipped as "the app
  can't read its own VAT rate" and taken an afternoon to diagnose.

### Not built yet, deliberately

Authentication *flows* (the session tables and primitives exist; the OTP and
MFA endpoints land with the parent experience in Phase 3), the upload pipeline
(Phase 2), and everything with a user interface. Phase 1 is the part that is
expensive to change later.

---

## Getting started

```bash
createdb spp
export MIGRATION_DATABASE_URL=postgres://localhost/spp
npm install
npm run db:migrate
npm run check          # typecheck + unit tests + database suite
```

## Layout

```
db/migrations/     numbered SQL. Source of truth. Never edit an applied one.
db/test/           assertion harness, fixture, and the RLS + invariant suites
src/lib/db.ts      session-context client. The pool is not exported, on purpose.
src/lib/ids.ts     claim codes, order numbers, public references
src/lib/audit.ts   typed audit writer
src/i18n/          Afrikaans and English, first-class from day one (§2.12)
scripts/           migration runner and test runner
```

## Before anything ships

From the architecture's launch checklist (§3.8, §15.2), none of which is code:

- Register an Information Officer with the Information Regulator
- Publish a PAIA manual and a POPIA privacy notice **in both site languages**
- Operator agreements with hosting, payment gateway, print lab, email/SMS
- A written security-compromise notification procedure (POPIA s22)
- Independent penetration test, targeting the claim flow and object-access path
