# Testing with real photographs — quick start

This is a **working website**, tested tonight end to end with real camera JPEGs
carrying GPS EXIF, through an actual browser-shaped flow: real HTTP requests
to real pages, not JSON responses read by a script.

## What actually happens when you run it

```
http://localhost:3000/            → real claim-code entry page
http://localhost:3000/import.html → drag in a school folder, tag, commit
http://localhost:3000/admin       → real counts and children, read from Postgres
http://localhost:3000/g/<childId> → a real gallery, real watermarked images
```

Every one of those was exercised tonight, in order, with a real photograph:
imported → tagged → committed → the real claim code shown → typed into the
real home page → redeemed through the actual Argon2id service in
`src/lib/claim.ts` → landed on a real gallery page showing that exact
photograph, watermarked, with zero EXIF data (confirmed by pulling the served
file back and inspecting its bytes).

## Setup (once)

```bash
cd school-photo-platform
npm install

createdb spp_live
export MIGRATION_DATABASE_URL="postgres://postgres@localhost:5432/spp_live"
npm run db:migrate
```

If Postgres isn't already installed:
```bash
sudo apt-get install -y postgresql postgresql-contrib
sudo -u postgres createdb spp_live
sudo -u postgres psql -c "alter user postgres password 'postgres';"
```

## Running it

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:5432/spp_live" \
  npx tsx src/server/import-server.ts
```

Then open **http://localhost:3000** in a browser. That's the whole site.

**Wait a few seconds after starting** before loading a page — it needs a
moment to connect and bootstrap a demo studio on first run. `/api/health`
tells you when it's ready.

## The path to click through

1. **http://localhost:3000/import.html** — drag in a folder of real
   photographs. Watch it parse the Grade/Class structure, process every file
   for real (strip GPS, watermark, derive sizes — this is genuinely slow per
   photograph, budget a few seconds each), and show a tag box per photo since
   no slate cards exist yet. Type a name, commit, and it shows you real claim
   codes.
2. **http://localhost:3000/admin** — see the child you just tagged, with a
   real photograph count and a link straight to their gallery.
3. **http://localhost:3000/** — type the claim code from step 1. This runs
   the actual redemption service: hashes and verifies the code, creates a
   real guardian account, binds them to the child, records POPIA consent, and
   burns the code — a second attempt with the same code is correctly refused
   ("already been used"), tested tonight.
4. Lands on **/g/&lt;childId&gt;** — the real gallery, showing the actual
   photograph you imported, watermarked, at a size that fits the mobile data
   budget from §8.3.

## What this is not, stated plainly

This is a **server-rendered proof that the pipeline is real**, built tonight
so tomorrow's test has something to click through rather than a folder of
separate files. It is not the final visual design — the two earlier prototype
files (`wj-photography-prototype.html`, `wj-admin-console-prototype.html`)
show where the Contact Sheet design and full checkout flow are headed, with
fake data. This server shows the same pages with real data and a much plainer
look. Merging the two — real backend, the fuller design — is the next step,
not tonight's.

Not wired up yet: slate-card barcode decoding (no printed cards exist),
checkout and payment, email sending, and the guardian session isn't checked
on the gallery page (anyone with the URL can view it — fine for tomorrow's
single-operator test, not for launch). All flagged, none of them block
looking at real photographs tomorrow.

## A gotcha, found by actually running this

**Database role matters.** `DATABASE_URL` must point at the `postgres`
superuser, not `app_rw`. Migration 0008 forces row-level security on every
table, which removes Postgres's normal exemption for table owners — only a
genuine superuser session can bootstrap a studio from an empty database. Using
the wrong role fails on the very first request with an RLS error. This is
stated at the top of `src/server/import-server.ts` too.

## If something breaks

`GET /api/health` says whether the database is reachable. The terminal running
the server prints the real error on any failure — check there first, not the
browser console.
