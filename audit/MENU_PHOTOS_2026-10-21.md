# Digital Menu — Complete Food Photo Management

**Date:** 2026-10-21
**Repository:** `nehraankit9898-beep/Byato` (Next.js 16 · TypeScript · Prisma 6 · Vercel + Neon PostgreSQL)
**Branch:** `arena/87c5d1fb-byato` (based on `main` @ `84c08ee`)
**Status:** implemented and verified locally — see §7 for the evidence log.

---

## 1. What was broken (inspection first)

The menu already had a photo column and card markup, but no way to use them:

| Finding | Evidence |
|---|---|
| `MenuItem.imageUrl String?` already exists — no new column needed | `prisma/schema.prisma:1013` |
| Validation accepts `https://…` **or `/api/media/…`** | `src/lib/menu.ts` `validateMenuItem` |
| **No `/api/media` route exists**, so that accepted prefix served nothing | grep over `src`, `tests`, `prisma`: zero route hits |
| **No upload endpoint at all** — no route reads a file body | route inventory: only JSON APIs |
| **No storage integration** — no `@vercel/blob`, no S3/AWS SDK, no Cloudinary, no multer/busboy | `package.json`, greps |
| Production CSP is `img-src 'self' data: blob:` → every external image URL is blocked in prod | `src/proxy.ts` §buildPageCsp |
| Owner UI had **no image control**: no upload, preview, replace or remove | `src/components/app/menu-view.tsx` |
| Public card rendered a 64×64 thumbnail **if** an `imageUrl` existed, and nothing otherwise | `src/components/public/menu-client.tsx` (~:304) |
| `sharp@0.35.5` is already a dependency, so server-side resizing needs no new package | `package.json:83` |

Net effect: an owner could not attach a photo, and a pasted external URL would
not render in production because of the CSP. The feature was **structurally
absent**, not merely unfinished.

## 2. Storage decision (requirement: persistent + production-compatible)

Requirement 6 explicitly forbids relying on the Vercel server's temporary
filesystem. Options considered:

| Option | Verdict |
|---|---|
| `public/uploads` / `fs.writeFile` | **Rejected** — read-only build output, ephemeral `/tmp` per instance: photos vanish on deploy/restart. This is exactly the anti-pattern the requirement names. |
| `@vercel/blob` / S3 / Cloudinary | **Not chosen** — would add a second stateful dependency plus new credentials to dev, test, CI, preview and prod for a ≤5 MB/photo workload. Re-using the existing managed database keeps one backup/restore and one tenant boundary. |
| **PostgreSQL table `MediaAsset` (Neon in prod), served by `/api/media/<uuid>`** | **Chosen** — persistent, transactional, tenant-scoped by FK, backed up with the catalog, zero new env vars. |

Photos are re-encoded to WebP ≤1600 px (typically 80–250 KB), so a 500-item
catalog is ~50–125 MB. The storage boundary is a single module
(`src/lib/media.ts`) plus the serving route; moving to object storage later
would not change the stored URL shape or the UI.

## 3. Database change

New **additive** migration `prisma/migrations/0016_menu_photos/migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "MediaAsset" (
  "id" TEXT NOT NULL, "hotelId" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'MENU_PHOTO',
  "mimeType" TEXT NOT NULL, "byteSize" INTEGER NOT NULL, "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL, "checksum" TEXT NOT NULL, "data" BYTEA NOT NULL,
  "createdBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_hotelId_checksum_kind_key" ON "MediaAsset"("hotelId","checksum","kind");
CREATE INDEX IF NOT EXISTS "MediaAsset_hotelId_createdAt_idx" ON "MediaAsset"("hotelId","createdAt");
-- FK hotelId → Hotel(id) ON DELETE CASCADE (guarded by pg_constraint check)
```

- Purely additive and re-runnable; no existing table/column/row is touched.
- Mirrored model-for-model in `prisma/schema.prisma`,
  `prisma/schema.test.prisma` and `prisma/schema.postgres.prisma`, so the CI
  `postgres-migrations` drift gate (`migrate diff --script` must be empty) stays green.
- `MenuItem.imageUrl` remains the display pointer: managed photos store
  `/api/media/<id>`; legacy `https://` rows are unaffected.
- Tenant isolation is structural: `hotelId` FK + cascade delete; every upload,
  update and delete is additionally filtered by the session's `hotelId`.

## 4. Implementation

| Area | Change |
|---|---|
| New module | `src/lib/media.ts` — magic-byte sniffing, capped binary reader, sharp pipeline (limitInputPixels, EXIF-rotate, strip metadata, resize ≤1600, WebP q82), de-duplicating store, reference-counted delete, tenant ownership check |
| Upload / remove | `src/app/api/menu/items/[id]/photo/route.ts` — `POST` (raw body) and `DELETE`; `MENU_MANAGE`; tenant-scoped 404; 40 uploads/min/tenant |
| Serving | `src/app/api/media/[id]/route.ts` — anonymous, UUID-validated, `ETag`/304, `immutable` caching, `nosniff`, `inline` |
| Tenant fence on normal item APIs | `POST /api/menu/items` and `PATCH /api/menu/items/[id]` reject a managed media URL that belongs to another tenant |
| Client | `api.upload()` in `src/lib/api-client.ts` (binary body, no JSON wrapper) |
| Owner UI | `menu-view.tsx`: 96×96 preview, Upload / Replace / Remove, client-side type+size checks, neutral "No photo" tile, 44×44 list thumbnails, create-then-upload flow, retry-after-photo-failure patches instead of duplicating, spinner state |
| Public QR menu | `menu-client.tsx`: card component with photo on top, name, tags, description, prep time, price, "Sold out" overlay, explicit **Add to cart** / **Choose options** button; `next/image` (`fill` + `sizes`) for managed photos, lazy plain `<img>` for legacy URLs; honest "No photo yet" / "Photo unavailable" placeholder; `onError` fallback |
| Docs | `docs/MENU_PHOTOS.md` (design, security, ops), `docs/DATABASE.md` (tenant + index notes) |
| Tests | `tests/menu-photos.test.ts` (22 tests) registered in `scripts/run-tests.ts` |

### Upload pipeline and its limits

1. `MENU_MANAGE` (owner / admin / manager). Kitchen and waiter roles are refused — they hold `MENU_READ`/`MENU_AVAILABILITY`, never `MENU_MANAGE`.
2. Item lookup is `{ id, hotelId }`; another tenant's id returns **404**, never 403-with-existence.
3. Per-tenant rate limit before any decode work.
4. Size cap **5 MB**, enforced on bytes actually received (`Content-Length` is only a fast path) — chunked bodies abort at the cap.
5. Format accepted **only** JPEG / PNG / WebP, decided by **magic bytes**; declared `Content-Type` and file names are never trusted. SVG (scriptable), GIF, PDF, text and binaries are rejected (415) before a decoder runs.
6. `sharp({ limitInputPixels: 24_000_000 })` — decompression bombs and corrupt payloads fail (400), not OOM.
7. Re-encode drops EXIF/GPS, applies orientation, never upscales.
8. De-duplication by `(hotelId, checksum, kind)`; concurrent identical uploads resolve via the unique fence (P2002 → reuse winner).
9. Replacement/removal deletes the old asset **only when no other item in the tenant references it**.

### UX / presentation (requirements 2–4, 9–10)

- Owner: preview before save, replace, remove, and a placeholder that is a
  neutral tile — **never a stock or AI-invented dish**.
- Customer: mobile-first stacked cards (`aspect-[4/3]`, `16/9` from `sm` up),
  responsive `srcset` via `next/image`, lazy loading, and all required fields
  (name, price, description, availability, Add to Cart) on every card.

## 5. Security review

| Threat | Control |
|---|---|
| Unauthorized upload/replacement | `MENU_MANAGE` + tenant-scoped item lookup (403 / 404) |
| Cross-tenant attachment | `mediaReferenceBelongsToHotel()` on item create/patch; foreign `/api/media/<id>` → 400 |
| Cross-tenant probing | UUID ids; wrong/unknown id and malformed id both 404; no tenant metadata in the response |
| Malicious file (SVG/HTML/JS) | magic-byte allowlist + full re-encode → response is always WebP with `nosniff` and `inline` |
| Decompression bomb / huge upload | 5 MB received-byte cap, 24 MP `limitInputPixels`, 1600 px output ceiling |
| Storage exhaustion | per-tenant rate limit, de-duplication, reference-counted deletion, single-row-per-photo |
| Cache poisoning / stale photo | ids are immutable; replacement issues a new id; `ETag` derived from the content checksum |
| Tenant deletion leftovers | `ON DELETE CASCADE` from `Hotel` |

## 6. Requirement coverage

| # | Requirement | Where |
|---|---|---|
| 1 | Upload on create **and** edit | `menu-view.tsx` ItemDialog (create-then-upload; edit uploads on save) |
| 2 | Preview / replace / remove / placeholder | same dialog + list thumbnails + `PhotoPlaceholder` |
| 3 | Responsive mobile-first QR menu cards | `menu-client.tsx` `FoodPhoto` + `MenuCard` |
| 4 | Name, price, description, availability, Add to Cart | `MenuCard` (explicit button + sold-out state) |
| 5 | Formats, size, MIME validation, secure handling | `src/lib/media.ts`, upload route |
| 6 | Persistent production-compatible storage | `MediaAsset` in PostgreSQL, `/api/media/<id>` (no filesystem) |
| 7 | URL/key in the existing model, migrations + tenancy | `MenuItem.imageUrl` + additive `0016_menu_photos` |
| 8 | Authorized users only, no cross-tenant access/replacement | `MENU_MANAGE`, tenant-scoped lookups, ownership check |
| 9 | Resize, compress, lazy load, responsive | sharp → WebP ≤1600; `next/image` `sizes`; lazy legacy `<img>` |
| 10 | No invented food photos; placeholder clearly distinct | neutral "No photo yet" / "Photo unavailable" labels, no stock imagery |
| 11 | Tests: upload, preview, update, delete, invalid file, authz, tenant isolation, production loading | `tests/menu-photos.test.ts` (§7) |
| 12 | Inspect first, reuse, no duplication, no unverified claims | §1 inspection; reused `MenuItem.imageUrl`, `sharp`, existing card/tags/price UI |

(Item 13 was truncated in the request and has not been guessed at.)

## 7. Test evidence

Local harness (`bun run test`) boots a fresh SQLite database + real Next.js dev
server, exactly like CI.

Command / scope | Result
---|---
`bun test tests/menu-photos.test.ts` | **22 pass / 0 fail**, 107 assertions
`bun test tests/phase12-menu.test.ts` | 10 pass / 0 fail (catalog + public QR regression)
`bun test tests/phase13-orders.test.ts` | 16 pass / 0 fail (ordering regression)
`bun test tests/body-cap-route-coverage.test.ts` | 5 pass / 0 fail (all API routes still use capped body readers)
`bun run typecheck` | clean
`bun run lint` | clean
`bun run scan:secrets` | clean
`bun run build` (production, `schema.postgres.prisma`) | success; `/api/media/[id]` and `/api/menu/items/[id]/photo` compiled as dynamic routes
Full `bun run test` (all registered suites + functional acceptance) | **ALL TEST SUITES PASSED**, exit 0

What the 22 tests specifically prove:

- **Upload & preview**: PNG upload returns `201`, stored row is WebP at the
  original 800×600, `MenuItem.imageUrl` matches, bytes are attached to the
  right tenant; the URL is publicly fetchable as WebP.
- **Production loading**: `Cache-Control` contains `immutable`,
  `X-Content-Type-Options: nosniff`, `ETag` revalidates to `304`; the served
  bytes sniff as WebP.
- **Replace**: a 2400×1200 JPEG is stored 1600×800 and smaller than the source;
  the previous asset is released and `404`s.
- **Update/duplicate**: identical bytes produce one row (same asset id).
- **Deletion**: `DELETE` clears `imageUrl`, removes the asset, and the URL 404s.
- **Invalid files**: 413 oversized (counted bytes), 415 for SVG/GIF/text even
  with a lying header, 400 for an empty body, 400 for a corrupt JPEG.
- **Authorization**: anonymous 401; `HOTEL_STAFF` 403 on upload and delete.
- **Tenant isolation**: another restaurant gets 404 on upload/delete and the
  row is unchanged; a foreign media URL is rejected (400) through both
  `PATCH` and item `POST`; a shared photo survives until the last reference.
- **Public menu**: the QR payload exposes the photo URL and `null` for items
  without one; source contracts assert `next/image` + `sizes`, honest
  placeholder labels, and the Add-to-cart / Choose-options / Sold-out states.

## 8. Risks and follow-ups

- **Database growth**: photos live in Neon. The design is sized for
  restaurant catalogs (≤5 MB upload → ~80–250 KB stored). A future
  multi-thousand-photo tenant should move `MediaAsset.data` to object storage
  behind the same `/api/media/<id>` contract; the UI and DB pointer do not change.
- **Image optimizer on Vercel**: `next/image` needs the optimizer enabled
  (default). Managed URLs are same-origin, so no `remotePatterns` entry is
  required. Legacy external URLs bypass the optimizer deliberately.
- **Legacy external URLs** remain CSP-blocked in production; the card shows
  "Photo unavailable" rather than a broken image. Owners can replace them with
  an upload.
- **Migration 0016 is new** — the `postgres-migrations` CI job validates it
  against a clean PostgreSQL 16 (apply + empty drift + table assertions).
- No new environment variables or secrets were introduced.
