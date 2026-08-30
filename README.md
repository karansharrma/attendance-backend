# Attendance Backend

NestJS + Prisma + PostgreSQL API for a face-recognition and geofenced attendance system.

Face matching and the GPS geofence check both happen **on the device**, offline. This service
does data, auth and sync: it never sees a photo and never computes an embedding.

---

## Quick start

```bash
cp .env.example .env
```

Generate two different secrets and paste them into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then:

```bash
docker compose up -d postgres
```

```bash
npm install && npx prisma migrate deploy && npm run db:seed && npm run start:dev
```

The API listens on `http://localhost:3000/api/v1`. Check it with:

```bash
curl http://localhost:3000/api/v1/health
```

Everything in one container pair instead:

```bash
docker compose up --build
```

> **npm 11 note.** npm 11 blocks dependency install scripts by default, which would leave
> `bcrypt` without its native binding and skip `prisma generate`. `package.json` carries an
> `allowScripts` allowlist for exactly the four packages that need one, so a plain
> `npm install` works. Older npm versions ignore the key.

### Seeded accounts

`npm run db:seed` creates four accounts (password `ChangeMe123!`, or `$SEED_PASSWORD`), two
sites, and a fortnight of attendance so the analytics endpoint has something to return:

| Email | Role | Geofence situation |
| --- | --- | --- |
| `admin@example.com` | ADMIN | — |
| `office@example.com` | EMPLOYEE | Head Office only → off-site punch-ins get flagged |
| `driver@example.com` | EMPLOYEE | Head Office + North Warehouse |
| `field@example.com` | EMPLOYEE | `isUnrestricted`, no sites → always `UNRESTRICTED` |

---

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `DATABASE_URL` | — | **Required.** Under compose the host is `postgres`, not `localhost`. |
| `JWT_ACCESS_SECRET` | — | **Required, ≥32 chars.** |
| `JWT_REFRESH_SECRET` | — | **Required, ≥32 chars, different from the access secret.** |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | |
| `JWT_REFRESH_EXPIRES_IN` | `30d` | |
| `THROTTLE_AUTH_LIMIT` | `5` | Login attempts per IP per window. |
| `THROTTLE_AUTH_TTL_SECONDS` | `60` | |
| `THROTTLE_GLOBAL_LIMIT` | `120` | |
| `THROTTLE_GLOBAL_TTL_SECONDS` | `60` | |
| `LATE_ARRIVAL_CUTOFF_MINUTES` | `555` | Minutes past local midnight; 555 = 09:15. |
| `REPORTING_TIMEZONE` | `UTC` | IANA zone the analytics day boundary is evaluated in. |
| `FACE_MATCH_THRESHOLD` | `0.75` | Served to devices by `GET /config`. |
| `MAX_LOCATION_ACCURACY_METERS` | `30` | Served to devices. |
| `EMBEDDING_MODEL_VERSION` | `mobilefacenet-v1` | Served to devices. |
| `MAX_SYNC_BATCH_SIZE` | `200` | Advertised limit; the DTO enforces 200. |
| `CORS_ORIGINS` | `*` | Comma-separated, or `*`. |
| `SEED_PASSWORD` | `ChangeMe123!` | `prisma/seed.ts` only. |

Config is validated at boot by `src/common/config/configuration.ts`. A missing `DATABASE_URL`
or a short JWT secret **stops the process from starting** — a container that silently comes up
with a weak secret is worse than one that refuses to come up.

---

## Migrations

```bash
npx prisma migrate dev --name <what-changed>
```

```bash
npx prisma migrate deploy
```

`migrate deploy` is what the compose `api` service runs at container start, so the same image
can be promoted between environments without a rebuild. The initial migration lives in
`prisma/migrations/20260101000000_init/`.

Regenerate the client after editing the schema:

```bash
npx prisma generate
```

---

## Endpoints

Base path: `/api/v1`. All responses are JSON. Send `Authorization: Bearer <accessToken>`
everywhere except `/auth/*` and `/health`.

Errors always come back in one shape, so the Android Retrofit client can parse them uniformly:

```json
{
  "statusCode": 400,
  "message": ["email must be a valid email address"],
  "error": "Bad Request",
  "path": "/api/v1/auth/login",
  "timestamp": "2026-08-26T09:14:22.481Z"
}
```

`message` is a string for thrown exceptions and a string array for DTO validation failures.

### `POST /auth/login` — public, rate-limited 5/min/IP

```json
{ "email": "admin@example.com", "password": "ChangeMe123!" }
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "expiresIn": "15m",
  "employee": {
    "id": "3f1c...",
    "name": "Ada Admin",
    "email": "admin@example.com",
    "role": "ADMIN",
    "isUnrestricted": false
  }
}
```

A wrong password and an unknown email both return the same `401` with
`"Invalid email or password"`, and both take the same amount of time — the unknown-email path
compares against a dummy hash so the two cannot be told apart.

### `POST /auth/refresh` — refresh token in the body

```json
{ "refreshToken": "eyJhbGciOiJIUzI1NiIs..." }
```

Returns a fresh `{ accessToken, refreshToken, tokenType, expiresIn }`. Both tokens rotate.
Presenting an access token here is a `401`: the two are signed with different secrets *and*
carry a `tokenType` claim that is checked.

### `GET /employees/:id` — self or admin

The device's full sync payload.

```json
{
  "id": "9c2b...",
  "name": "Owen Office",
  "email": "office@example.com",
  "role": "EMPLOYEE",
  "isUnrestricted": false,
  "embeddingModelVersion": "mobilefacenet-v1",
  "faceEmbedding": "AACAPwAAAAAAAAAA...",
  "sites": [
    {
      "id": "1111...",
      "name": "Head Office",
      "latitude": 12.9716,
      "longitude": 77.5946,
      "radiusMeters": 150
    }
  ],
  "createdAt": "2026-08-01T10:00:00.000Z"
}
```

`faceEmbedding` is base64 of the raw little-endian float32 vector — byte-identical to the BLOB
the device caches in Room, so it round-trips with no re-encoding.

**The key is absent entirely when an admin reads someone else's record.** There is no
operational reason for an admin to hold another person's biometric template, and every release
of one is logged with the employee id, model version and byte length.

### `GET /employees` — admin, paginated

`?page=1&limit=50&search=owen&role=EMPLOYEE`

```json
{
  "data": [
    {
      "id": "9c2b...",
      "name": "Owen Office",
      "email": "office@example.com",
      "role": "EMPLOYEE",
      "isUnrestricted": false,
      "embeddingModelVersion": "mobilefacenet-v1",
      "isEnrolled": true,
      "sites": [ /* ... */ ],
      "createdAt": "2026-08-01T10:00:00.000Z"
    }
  ],
  "meta": { "total": 4, "page": 1, "limit": 50, "totalPages": 1, "hasNextPage": false }
}
```

`isEnrolled` reports whether a template exists without revealing it.

### `POST /employees` · `PATCH /employees/:id` · `DELETE /employees/:id` — admin

```json
{
  "name": "Nina New",
  "email": "nina@example.com",
  "password": "AtLeastEight1!",
  "role": "EMPLOYEE",
  "isUnrestricted": false,
  "siteIds": ["1111..."]
}
```

`PATCH` takes any subset; supplying `password` re-hashes and replaces it.

### `POST /enrollment` — admin

```json
{
  "employeeId": "9c2b...",
  "embedding": "AACAPwAAAAAAAAAA...",
  "embeddingModelVersion": "mobilefacenet-v1"
}
```

```json
{
  "employeeId": "9c2b...",
  "embeddingModelVersion": "mobilefacenet-v1",
  "embeddingBytes": 512,
  "dimensions": 128,
  "supersededPrevious": true,
  "enrolledAt": "2026-08-26T09:20:11.004Z"
}
```

One template per employee — the device already averages its multi-angle samples into a single
centroid before uploading. The response echoes **metadata only**, never the bytes, not even to
the admin who just uploaded them. The base64 must decode to a byte length that is a multiple
of 4 (float32) and at most 16 KiB, so a corrupt upload is a clear `400` rather than a device
that silently fails every match afterwards.

`DELETE /enrollment/:employeeId` clears a template, e.g. before re-enrolling on a new model.

### `POST /attendance/sync` — employee

The device pushes its offline queue. **Idempotent by design.**

```json
{
  "records": [
    {
      "id": "0f3d5a1e-9c44-4a0b-8e51-6c9f0c1a2b3d",
      "timestamp": "2026-08-26T03:41:09.000Z",
      "latitude": 12.9716,
      "longitude": 77.5946,
      "matchedSiteId": "1111...",
      "faceMatchConfidence": 0.874,
      "status": "VERIFIED",
      "isMockLocation": false
    }
  ]
}
```

```json
{
  "accepted": 1,
  "rejected": 0,
  "results": [{ "id": "0f3d5a1e-...", "outcome": "created" }],
  "serverTime": "2026-08-26T09:22:40.117Z"
}
```

`outcome` is `created`, `updated` or `rejected`. `200`, not `201` — a retry that finds
everything already stored is just as successful as the first attempt that stored it.

Four properties the mobile sync worker depends on:

1. **Upsert on the client-generated UUID.** The worker retries whenever the network drops
   mid-request, so the same batch arrives more than once as a matter of routine. A blind
   insert would duplicate every record that was written but whose response was lost —
   precisely the case retries exist to handle.
2. **An admin's review decision is never clobbered.** `reviewStatus`, `reviewedByAdminId`,
   `reviewedAt` and `reviewNote` are excluded from the update branch, so a record re-pushed
   months later cannot reset an `APPROVED` flag back to `PENDING`.
3. **Per-record outcomes**, so the worker can mark records individually rather than
   all-or-nothing.
4. **`employeeId` is advisory.** Records are always filed under the employee in the access
   token. If the field is present and disagrees, the *whole batch* is rejected with `403` —
   a device filing attendance under someone else's name is a security event, not a
   data-quality problem.

An id repeated inside one batch collapses to a single upsert, so the request is idempotent
with itself as well as with earlier requests.

### `GET /admin/attendance` — admin, paginated

`?status=FLAGGED_OUTSIDE_GEOFENCE&reviewStatus=PENDING&employeeId=...&dateFrom=2026-08-01T00:00:00Z&dateTo=2026-09-01T00:00:00Z&page=1&limit=50&sortBy=timestamp&sortOrder=desc`

```json
{
  "data": [
    {
      "id": "0f3d5a1e-...",
      "employeeId": "9c2b...",
      "employeeName": "Owen Office",
      "employeeEmail": "office@example.com",
      "timestamp": "2026-08-26T03:41:09.000Z",
      "latitude": 12.9716,
      "longitude": 77.5946,
      "matchedSiteId": "1111...",
      "matchedSiteName": "Head Office",
      "faceMatchConfidence": 0.874,
      "status": "VERIFIED",
      "isMockLocation": false,
      "reviewStatus": "APPROVED",
      "reviewedByAdminId": "3f1c...",
      "reviewedAt": "2026-08-26T09:30:00.000Z",
      "reviewNote": null,
      "createdAt": "2026-08-26T03:41:12.550Z"
    }
  ],
  "meta": { "total": 128, "page": 1, "limit": 50, "totalPages": 3, "hasNextPage": true }
}
```

`dateFrom` is inclusive, `dateTo` exclusive. `matchedSiteName` is `null` when the site has
since been deleted — see the note on `matchedSiteId` below.

### `PATCH /admin/attendance/:id/review` — admin

```json
{ "reviewStatus": "APPROVED", "note": "Called ahead, working from the depot" }
```

Returns the updated row in the shape above, with `reviewedByAdminId` set to the calling admin.
Only `APPROVED` and `REJECTED` are accepted: moving a record back to `PENDING` would erase who
reviewed it, so re-opening is deliberately not an option here.

### `POST /admin/sites` · `PATCH /admin/sites/:id` · `DELETE /admin/sites/:id` — admin

```json
{ "name": "Head Office", "latitude": 12.9716, "longitude": 77.5946, "radiusMeters": 150 }
```

`GET /admin/sites` (paginated) and `GET /admin/sites/:id` round out the CRUD; both add
`assignedEmployeeCount`.

`radiusMeters` has a floor of 25. That is not arbitrary: the device refuses GPS fixes worse
than 30 m accuracy, so a smaller radius would reject legitimate punch-ins on a bad-signal day.

### `POST /admin/employees/:id/sites` · `DELETE /admin/employees/:id/sites/:siteId` — admin

```json
{ "siteId": "1111..." }
```

```json
{ "employeeId": "9c2b...", "siteId": "1111...", "assigned": true }
```

Assign is idempotent — re-assigning an already-assigned site is a no-op rather than a `409`,
because the admin UI fires it from a checkbox that may already be checked. Unassigning the
last site logs a warning: with zero sites the device treats every punch-in as `UNRESTRICTED`.

### `GET /admin/analytics/summary` — admin

`?dateFrom=2026-08-01T00:00:00Z&dateTo=2026-09-01T00:00:00Z` (defaults to the last 30 days)

```json
{
  "range": { "from": "2026-07-27T00:00:00.000Z", "to": "2026-08-26T09:35:00.000Z", "timezone": "UTC" },
  "totals": {
    "punchIns": 128,
    "activeEmployees": 3,
    "verified": 104,
    "flaggedOutsideGeofence": 12,
    "unrestricted": 12,
    "mockLocationAttempts": 0
  },
  "review": { "pending": 9, "approved": 116, "rejected": 3 },
  "lateArrivals": { "cutoffMinutesOfDay": 555, "cutoffLocalTime": "09:15", "count": 21 },
  "dailyTrend": [
    { "date": "2026-08-24", "total": 3, "flagged": 0, "late": 1 },
    { "date": "2026-08-25", "total": 3, "flagged": 1, "late": 0 }
  ]
}
```

"Late" is a wall-clock question, so the day boundary and the cut-off comparison both run in
`REPORTING_TIMEZONE` rather than UTC — a 09:15 cut-off evaluated in UTC is wrong for every
deployment that is not on GMT.

### `GET /config` — any authenticated user

**Beyond the endpoint list in the build spec**, added because the values it serves are
meaningless without somewhere to read them: the Android client applies the face-match
threshold on-device and needs to pick up a change without an app release.

```json
{
  "faceMatchThreshold": 0.75,
  "embeddingModelVersion": "mobilefacenet-v1",
  "maxLocationAccuracyMeters": 30,
  "lateArrivalCutoffMinutes": 555,
  "maxSyncBatchSize": 200
}
```

Authenticated rather than public: a match threshold is an attacker-useful hint about how the
gate is tuned.

### `GET /health` — public

Unauthenticated on purpose — container orchestrators cannot hold a JWT.

```json
{ "status": "ok", "database": "up", "uptimeSeconds": 421 }
```

---

## Security model

- **Authentication is on by default.** `JwtAuthGuard` is registered globally; a route opts out
  with `@Public()`. A forgotten decorator therefore fails closed.
- **`RolesGuard`** runs after it. `/admin/*` controllers and `/enrollment` carry
  `@Roles(Role.ADMIN)` at the class level.
- **Guard order** is throttle → authenticate → authorise, cheapest rejection first.
- **Passwords** are bcrypt, cost 10, never stored or returned in plaintext.
- **`ValidationPipe`** runs with `whitelist` *and* `forbidNonWhitelisted`: unknown fields are
  a `400`, not silently dropped. An unexpected field is almost always a version mismatch worth
  surfacing.
- **Request logging** deliberately excludes bodies — they carry passwords on `/auth/login` and
  embedding bytes on `/enrollment`.
- **Face embeddings** leave the server on exactly one route, for exactly one caller (the
  owner), and every release is logged.

---

## Firebase push notifications

The API sends Firebase Cloud Messaging (FCM) notifications when an admin assigns a new site to
an employee and when an employee creates a punch record. Every admin receives punch-ins; each
admin can independently enable or disable their own punch-out alerts. FCM registration tokens
are stored per account, so the same API supports Android/iOS and a browser dashboard.

1. Create a Firebase service account in Firebase Console and put its one-line JSON credential in
   `FIREBASE_SERVICE_ACCOUNT_JSON` (see `.env.example`). Do not commit that credential.
2. After Firebase Messaging obtains or refreshes a token in either client, call
   `POST /notifications/devices` with `{ "token": "...", "platform": "android" | "ios" | "web" }`
   using that user's JWT. On sign-out or permission revocation call
   `DELETE /notifications/devices/:token`.
3. The admin app/dashboard can read and change its own punch-out setting using
   `GET /notifications/preferences` and `PATCH /notifications/preferences` with
   `{ "punchOutNotificationsEnabled": false }`.

The mobile and web clients still need the normal Firebase Messaging client setup (including a
web service worker) to request permission, obtain the FCM token, and display foreground messages.
If Firebase credentials are absent or temporarily invalid, attendance and assignment operations
continue normally; delivery is skipped and logged rather than failing the business operation.

### Refresh tokens are stateless

Signed with their own secret and a `tokenType` claim, with no server-side record. This keeps
the Prisma schema exactly as specified, at the cost of not being able to revoke an individual
refresh token before it expires.

If revocation matters for your deployment: add a `RefreshToken` model storing a bcrypt hash of
the issued token plus `employeeId` and `expiresAt`, verify it in `AuthService.refresh()`, and
delete the old row on rotation. Nothing else in the service changes.

---

## Schema notes

Two deliberate choices worth knowing about:

- **`AttendanceRecord.matchedSiteId` is not a foreign key.** A record must stay readable after
  the site it was tagged to has been deleted — attendance is an audit trail, and deleting a
  site should not rewrite history. Site names on the admin query are resolved with one extra
  lookup instead of a join, and come back `null` for a deleted site.
- **Indexes** on `employeeId`, `timestamp`, `status`, `reviewStatus` and the composite
  `(employeeId, timestamp)`, since the dashboard filters almost exclusively on those.

Beyond the models in the spec, the only additions are `updatedAt` timestamps, `reviewedAt` and
`reviewNote` (an approve/reject decision needs somewhere to record when and why), and
`assignedAt` on the join table.

---

## Tests

```bash
npm run test:e2e
```

The e2e suites cover the two flows the spec calls out:

- **`test/auth.e2e-spec.ts`** — login success and both failure modes, the "unknown email and
  wrong password are indistinguishable" property, validation errors, refresh rotation,
  access-token-as-refresh-token rejection, deleted-account rejection, unauthenticated `401`,
  employee-hits-admin-route `403`, and login rate limiting.
- **`test/attendance-sync.e2e-spec.ts`** — batch storage, replay idempotency, an id repeated
  inside one batch, an admin review surviving a device replay, cross-employee rejection,
  `employeeId` defaulting to the token holder, mock-location flagging, malformed payloads, and
  a record staying readable after its site is deleted.

Both boot the **real** application graph — same modules, same guards, same global
`ValidationPipe`, via the `configureApp()` helper that `main.ts` also uses, so the tests cannot
pass against rules that do not actually run in production.

They need a live Postgres and will fail without one:

```bash
docker compose up -d postgres && npx prisma migrate deploy
```

The harness sets `NODE_ENV=test` and truncates between suites. `PrismaService.truncateAll()`
throws unless `NODE_ENV=test`, so it cannot be pointed at a real database by accident.
**Point `DATABASE_URL` at a throwaway database** — the suites wipe every table.

The throttler is stubbed out for most suites (the auth tests make more login attempts than the
production limit allows, and a shared bucket would make them order-dependent); the rate-limit
test opts back in.

---

## Project layout

```
src/
 ├── auth/         login, refresh, JWT strategies, guards, roles + public decorators
 ├── employees/    CRUD plus the device sync payload (and its embedding scoping)
 ├── sites/        geofenced site CRUD and employee assignment
 ├── attendance/   the idempotent sync endpoint
 ├── enrollment/   admin face-template upload and revocation
 ├── admin/        attendance query, review, analytics
 ├── config/       device config + health
 ├── common/       env validation, exception filter, logging interceptor, pagination
 └── prisma/       PrismaService (global)
```

---

## Android client compatibility

This backend was built to its own spec, which differs from the Android app's spec in a few
places. Reconciling them is a small, mechanical change on **one** side — listed here so the
choice is explicit rather than discovered at integration time:

| | This backend | Android client as built |
| --- | --- | --- |
| JSON casing | camelCase (`employeeId`) | snake_case (`employee_id`, via `@SerialName`) |
| Roster fetch | `GET /employees/:id` per employee | `GET /roster` (all employees + sites) |
| Attendance push | `POST /attendance/sync` with a `records` array | `POST /attendance` one record at a time |
| Enrollment | `POST /enrollment`, admin-only, metadata-only response | employee self-enrolls, expects the embedding back |
| Auth | JWT bearer required | no auth layer yet |

The smallest path to a working pair is to change the Android side: swap the `@SerialName`
annotations to camelCase, point `AttendanceApiService` at `/attendance/sync` with a
single-element `records` array, replace `/roster` with a per-employee `/employees/{id}` call,
and add an `Authorization` header interceptor. Say the word and I'll do it.
