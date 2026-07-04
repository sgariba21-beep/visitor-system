# Visitor Management System

A progressive web app (PWA) for managing school visitors — from parent pre-registration and QR-based gate check-in/out, to real-time admin dashboards and visit history analytics.

Built with **React 19** and **Supabase (Postgres)**, with a hand-rolled offline-first gate scanning experience designed to work reliably on school networks.

---

## Features

### For Parents / Visitors
- Pre-register a visit online (no account required)
- Search for the student(s) being visited by name or class
- Select visit date, purpose, and relationship
- Receive a unique QR code token (`VIS-XXXXXX`) to present at the gate

### For Gate Staff
- Scan QR codes with a phone camera (or manually look up a visitor)
- Check visitors in on arrival and out on departure
- Register walk-in visitors on the spot
- Works offline — caches today's visits locally and syncs when reconnected
- Installable as a home screen app (PWA)

### For Administrators
- **Live Dashboard** — real-time visitor counts (on campus, checked out, walk-ins, not yet arrived)
- **Student Management** — add/edit/deactivate students, bulk import via CSV
- **Visit History** — search and filter by date range, status, purpose, or visitor/student name
- **Settings** — change the Gate PIN without a redeploy

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7 |
| Database | Supabase (Postgres) |
| Auth | Supabase Auth (email/password) |
| Realtime | Supabase Realtime (`postgres_changes`) for the live dashboard |
| Offline sync | Dexie (IndexedDB) — local cache + write outbox, scoped to the Gate page |
| QR Scanning | html5-qrcode |
| QR Generation | qrcode.react |
| CSV Import | PapaParse |
| Hosting | Vercel |
| PWA | Service Worker (cache-first assets, network-first HTML) |

---

## App Structure

```
/register     — Parent/visitor pre-registration (public)
/login        — Staff login (public)
/gate         — Gate scanning hub (PIN-protected)
/admin        — Admin area (requires Supabase Auth)
  /dashboard  — Live stats
  /students   — Student management
  /visits     — Visit history
  /settings   — Change the Gate PIN
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project with the schema in `supabase/migrations/` applied

### Installation

```bash
git clone https://github.com/your-org/visitor-system.git
cd visitor-system
npm install
```

### Environment Variables

Create a `.env` file in the project root (see `.env.example`):

```env
REACT_APP_SUPABASE_URL=https://your-project-ref.supabase.co
REACT_APP_SUPABASE_ANON_KEY=your_supabase_publishable_or_anon_key
```

The Gate PIN is no longer an env var — it lives in the `gate_settings` table (default `1234`) and is changed from `/admin/settings`.

### Running Locally

```bash
npm start
```

Opens at [http://localhost:3000](http://localhost:3000).

---

## Deployment

### Build

```bash
npm run build
```

### Deploy to Vercel

```bash
npm install -g vercel
vercel login
vercel --prod
```

`vercel.json` handles SPA routing rewrites and cache headers (1-year immutable for hashed JS/CSS under `/static`, no-cache for `index.html` and `sw.js`). Set `REACT_APP_SUPABASE_URL` and `REACT_APP_SUPABASE_ANON_KEY` as environment variables in the Vercel project settings — `.env` itself is never deployed.

---

## Database Schema (Postgres)

Defined in `supabase/migrations/`, applied in order. Apply with the Supabase CLI (`supabase db push`) or via the SQL editor in the Supabase dashboard.

### `students`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `name` | text | Student full name |
| `class` | text | Class/grade (e.g. "Form 3A") |
| `student_id` | citext | Unique student identifier (case-insensitive, nullable). Enforced by a partial unique index — real DB constraint instead of a client-side check |
| `is_active` | boolean | Controls visibility in registration search |
| `created_at` | timestamptz | When added |

### `visits`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `visitor_name` / `visitor_phone` | text | Visitor contact info |
| `relationship` | text | Relationship to student(s) |
| `purpose` / `purpose_other` | text | Reason for visit (category + free text if "Other") |
| `visit_date` | date | QR only activates on this date |
| `status` | enum | `registered` → `checked_in` → `checked_out` |
| `qr_token` | text | Unique token e.g. `VIS-A3X9K2`, generated server-side with collision retry |
| `registered_at` / `checked_in_at` / `checked_out_at` | timestamptz | Lifecycle timestamps |
| `created_by` | text | `"self"` (parent) or `"gate_staff"` (walk-in) |

### `visit_students` (junction table)

Normalizes the visit↔student relationship (a visit can have multiple students, e.g. siblings) instead of an embedded array. `student_id` is a nullable FK (`on delete set null`) so hard-deleting a student doesn't break visit history — `student_name`/`class` are denormalized snapshot columns that preserve the historical record regardless.

### `gate_settings` (singleton)

A single row (`id` is always `true`, enforced by a check constraint) holding the current Gate PIN, editable from `/admin/settings`. `anon` gets read-only access — needed so the unauthenticated Gate page can fetch and locally cache the PIN for offline verification, the same trust model as before (the PIN was already visible in the client bundle when it was an env var; this isn't a new exposure).

### Writes go through RPCs, not raw table access

Since the Gate and Register pages have no Supabase Auth (same PIN/no-auth trust model as before), all anon-role writes go through three `SECURITY DEFINER` Postgres functions rather than direct table grants:

- `create_visit(...)` — atomically inserts a `visits` row + its `visit_students` rows, generating and collision-checking the QR token server-side.
- `check_in_visit(p_qr_token)` / `check_out_visit(p_qr_token)` — guarded status transitions; an illegal transition (e.g. double check-out) raises a clean error instead of corrupting state.

RLS is enabled on all three tables: `anon` gets read-only access (active students only); `authenticated` (admin) gets full CRUD.

---

## CSV Import Format (Students)

The Students page supports bulk import. CSV must have these headers:

```csv
name,class,studentId
Alice Johnson,Form 3A,STU-001
Bob Smith,Primary 5,STU-002
```

`studentId` is required for visitors to verify students during registration. Duplicate IDs (including duplicates within the same import batch) are rejected by the database's unique constraint and reported as skipped rows.

---

## Offline Support

Supabase's client has no built-in offline persistence, so the Gate page (the only place offline support is needed — Register and `/admin` pages require connectivity) uses a hand-rolled sync layer in `src/lib/offlineDb.js` and `src/lib/offlineSync.js`:

1. **Cache Warming** — On entering the scanner, today's visits and active students are explicitly fetched into a local Dexie (IndexedDB) mirror
2. **Optimistic UI** — Check-in/out and walk-in registration update the UI immediately, then race a short timeout against the live Supabase call
3. **Write Outbox** — If the live call fails or times out, the mutation is durably queued in Dexie and retried on reconnect, on a periodic interval, and on page load — surfaced to staff as a visible "queued — will sync when online" state
4. **Read Fallback** — QR lookup and manual search try Supabase first, then fall back to the Dexie cache if offline
5. **PIN Caching** — The Gate PIN itself is cached locally too, so the PIN screen works offline even though the PIN is admin-editable (not a build-time constant); a fresh fetch on each load keeps it in sync with `/admin/settings`
6. **Status Banner** — The gate page shows a live online/offline indicator and cache-readiness state
7. **Service Worker** — Static assets served from cache; the app loads even with no connection (API calls bypass the service worker entirely — durability for those comes from the outbox, not the SW)

---

## Authentication

| Area | Method |
|------|--------|
| Admin (`/admin/*`) | Supabase Auth — email/password. Protected via `ProtectedRoute` component. |
| Gate (`/gate`) | 4–6 digit PIN (stored in `gate_settings`, editable from `/admin/settings`) confirmed via `sessionStorage` (cleared on browser close). |
| Registration (`/register`) | No auth required. |

Staff accounts are created directly in the Supabase dashboard (Authentication → Users) — there is no public sign-up.

---

## Project Structure

```
src/
├── App.js                   # Route definitions
├── index.js                 # Entry point + service worker registration
├── components/
│   ├── ProtectedRoute.jsx   # Auth guard for admin routes
│   └── Spinner.jsx          # Loading indicator
├── hooks/
│   └── useAuth.js           # Supabase auth state hook
├── lib/
│   ├── supabaseClient.js    # Supabase client init
│   ├── offlineDb.js         # Dexie schema (visits/students mirror + outbox)
│   └── offlineSync.js       # warmCache / enqueue / flushOutbox / read-fallback helpers
├── pages/
│   ├── RegisterPage.jsx     # Visitor pre-registration
│   ├── LoginPage.jsx        # Staff login
│   ├── GatePage.jsx         # Gate scanning (check-in/out, offline-first)
│   └── admin/
│       ├── AdminLayout.jsx  # Sidebar layout
│       ├── DashboardPage.jsx
│       ├── StudentsPage.jsx
│       ├── VisitsPage.jsx
│       └── SettingsPage.jsx # Change the Gate PIN
└── utils/
    └── generateToken.js     # QR token generator (used only for offline walk-in placeholders — real tokens are server-generated)
public/
├── sw.js                    # Service worker
└── manifest.json            # PWA manifest (start_url: /gate)
supabase/
└── migrations/               # Schema, RLS policies, and RPC functions (SQL)
```

---

## License

MIT
