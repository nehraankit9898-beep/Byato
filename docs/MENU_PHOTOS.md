# Digital Menu — Food Photos

Owner-managed food photography for the QR menu: upload / preview / replace /
remove in the menu editor, responsive photo cards on the public menu.

Implemented in the "Digital Menu — Complete Food Photo Management" change.
The database column it fills (`MenuItem.imageUrl`) already existed since
Phase 12; what was missing was every layer around it — there was **no upload
endpoint, no `/api/media` route, no storage integration**, and the production
CSP (`img-src 'self' data: blob:`) silently blocked every external image URL
the validator accepted. Owners therefore could not put a photo on an item at
all, even though the public card had markup for one.

## Where the bytes live (and why)

| Option | Rejected because |
|---|---|
| `public/uploads` / `fs.writeFile` | Vercel's filesystem is read-only in the build output and `/tmp` is ephemeral and per-instance — a photo would disappear on the next deploy/instance. Explicitly ruled out by the requirement. |
| `@vercel/blob`, S3, Cloudinary | Adds a second stateful dependency and a new credential to every environment (dev, test, CI, preview, prod) for a 5 MB-per-photo workload. |

**Chosen: PostgreSQL (`MediaAsset.data BYTEA`) in the same (Neon) database as
the menu**, served by this app at `/api/media/<uuid>`.

- Survives deploys, restarts and serverless instance recycling.
- No new environment variable, bucket, ACL or CORS surface.
- One backup/restore covers catalog **and** photos atomically
  (`docs/BACKUP_AND_RESTORE.md`).
- Tenant deletion cascades: `MediaAsset.hotelId → Hotel.id ON DELETE CASCADE`.

Sizing: photos are re-encoded to WebP at ≤1600 px (typically 80–250 KB). A
500-item catalog is roughly 50–125 MB — comfortably inside a Neon plan. The
storage layer is isolated in `src/lib/media.ts`; if a future catalog outgrows
the database, only `storeMenuPhoto()` / the `/api/media/[id]` handler need an
object-storage backend, and the stored URL shape can stay the same.

### Table

```
MediaAsset
  id         uuid (pk)
  hotelId    -> Hotel(id) ON DELETE CASCADE
  kind       'MENU_PHOTO'
  mimeType   'image/webp'
  byteSize   int     width int    height int
  checksum   sha256(webp bytes)
  data       BYTEA   -- the only copy of the pixels
  createdBy  uuid?   -- uploader (audit correlation)
  createdAt  timestamptz
  UNIQUE (hotelId, checksum, kind)   -- identical re-upload is free
  INDEX  (hotelId, createdAt)
```

Migration: `prisma/migrations/0016_menu_photos/migration.sql` (additive only,
re-runnable, matches `prisma/schema.postgres.prisma` exactly — the CI
`postgres-migrations` drift gate is empty).

`MenuItem.imageUrl` still stores a plain string, so no destructive change was
needed there: managed photos store `/api/media/<uuid>`, legacy rows may still
hold an external `https://` URL.

## Upload pipeline

`POST /api/menu/items/:id/photo` (raw image body, `Content-Type: image/*`)

1. **Auth**: `MENU_MANAGE` (owner, admin, manager; kitchen/waiter refused with
   403) and the item must belong to the caller's `hotelId` (otherwise 404).
2. **Rate limit**: 40 uploads/minute/tenant.
3. **Size**: `Content-Length` fast-reject + counted read of the actual bytes —
   5 MB cap, chunked bodies abort at the cap (413).
4. **Type**: magic-byte sniffing for JPEG / PNG / WebP only. The declared
   header and the file name are never trusted; SVG (scriptable), GIF, PDF and
   arbitrary binaries are refused (415) before any decoder runs.
5. **Decode guard**: `sharp({ limitInputPixels: 24_000_000 })`; a decompression
   bomb or corrupt payload is rejected (400).
6. **Re-encode**: EXIF orientation applied, metadata/GPS dropped, resized to
   ≤1600 px (never upscaled), WebP q82. Output is always a clean raster.
7. **Persist**: de-duplicated by `(hotelId, checksum)`, then the item row is
   updated tenant-scoped; a replacement releases the previous asset **only if
   no other item still references it** (reference counting, not blind delete).

`DELETE /api/menu/items/:id/photo` clears `imageUrl` (placeholder shown) and
releases the asset under the same reference-count rule.

`GET /api/media/:id` serves the bytes anonymously — a QR menu is public by
design, and the id is an unguessable UUID with no tenant metadata. Responses
are `Cache-Control: public, max-age=31536000, immutable`, `ETag` = checksum
(304 supported), `X-Content-Type-Options: nosniff`, `Content-Disposition:
inline`.

## Owner UI (`src/components/app/menu-view.tsx`)

In the create/edit item dialog: 96×96 preview, **Upload photo / Replace photo
/ Remove**, file type + size validation before the request, and a neutral
"No photo" tile when empty. A new item is created first and its staged photo
is uploaded immediately after, so "add item with photo" is one action. If the
photo step fails the item is kept and the toast says the item saved but the
photo did not — never a silent half-state.

List rows show a 44×44 thumbnail (or the same neutral placeholder).

The placeholder is intentionally **not** a stock or AI-generated dish photo:
inventing a picture of food the kitchen does not serve would misrepresent the
menu. "No photo" and "Photo unavailable" are the only non-photo states.

## Public QR menu (`src/components/public/menu-client.tsx`)

Each card is a mobile-first `<article>`: photo on top (`aspect-[4/3]`, widening
to `16/9` from `sm`), then name, dietary tags, description, prep time, price,
availability ("Sold out" overlay + label) and an explicit **Add to cart** /
**Choose options** button (the former unlabelled "+" was unusable with a
screen reader). Managed photos go through `next/image` (`fill` + `sizes`) for
responsive srcsets and lazy loading; legacy external URLs use a plain
`<img loading="lazy">`, and an `onError` fallback swaps in the neutral
placeholder with "Photo unavailable".

## Tests — `tests/menu-photos.test.ts`

Registered in `scripts/run-tests.ts` (the harness fails if a suite is not).
22 tests, all passing against the real dev server + a real SQLite database:

- magic-byte recognition/rejection (JPEG/PNG/WebP vs SVG/GIF/PDF/text)
- upload → stored as WebP, attached to `MenuItem.imageUrl`, tenant row correct
- served bytes are WebP with immutable cache, ETag/304, nosniff
- 404 for unknown/malformed media ids
- 413 oversized upload (counted bytes), 415 for lying/unsupported types, 400 empty
- 400 for a corrupt JPEG (valid magic, undecodable body)
- 2400×1200 → 1600×800 downscale, smaller payload, old asset released
- identical bytes de-duplicated (same asset id)
- create-then-upload flow (new item starts with `null` = placeholder)
- delete clears the item and the asset 404s
- anonymous 401; `HOTEL_STAFF` (no `MENU_MANAGE`) 403
- cross-tenant upload/delete 404 and the row is unchanged
- foreign media URL rejected by `PATCH` and by item `POST` (400)
- shared photo survives removal until the last reference goes
- public QR payload exposes the photo URL, `null` when there is none
- source contracts: responsive `next/image` + honest placeholder labels; owner
  upload/replace/remove controls

Related suites re-run green with this change: `phase12-menu`, `phase13-orders`,
`body-cap-route-coverage`.

## Operations

- **No new env vars.** Nothing to configure in Vercel/Neon.
- **Monitoring**: `SELECT count(*), sum("byteSize") FROM "MediaAsset";`
- **Reclaim** (assets orphaned by a manual DB edit):
  ```sql
  DELETE FROM "MediaAsset" m
  WHERE NOT EXISTS (
    SELECT 1 FROM "MenuItem" i
    WHERE i."hotelId" = m."hotelId"
      AND i."imageUrl" = '/api/media/' || m."id"
  );
  ```
- **Backups** already include the table (pg_dump covers every table); a restore
  brings photos back with the catalog.
- **Do not** move `MediaAsset.data` to a local disk path — that reintroduces
  the ephemeral-filesystem bug this design exists to prevent.
