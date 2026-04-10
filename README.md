# Visitor Management System

A progressive web app (PWA) for managing school visitors — from parent pre-registration and QR-based gate check-in/out, to real-time admin dashboards and visit history analytics.

Built with **React 19** and **Firebase**, with an offline-first gate scanning experience designed to work reliably on school networks.

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

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7 |
| Database | Firebase Firestore (with IndexedDB offline persistence) |
| Auth | Firebase Authentication (email/password) |
| QR Scanning | html5-qrcode |
| QR Generation | qrcode.react |
| CSV Import | PapaParse |
| Hosting | Firebase Hosting |
| PWA | Service Worker (cache-first assets, network-first HTML) |

---

## App Structure

```
/register     — Parent/visitor pre-registration (public)
/login        — Staff login (public)
/gate         — Gate scanning hub (PIN-protected)
/admin        — Admin area (requires Firebase Auth)
  /dashboard  — Live stats
  /students   — Student management
  /visits     — Visit history
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Firebase project with Firestore and Authentication enabled

### Installation

```bash
git clone https://github.com/your-org/visitor-system.git
cd visitor-system
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
REACT_APP_GATE_PIN=1234

REACT_APP_FIREBASE_API_KEY=your_api_key
REACT_APP_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your_project_id
REACT_APP_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
REACT_APP_FIREBASE_APP_ID=your_app_id
```

`REACT_APP_GATE_PIN` is the 4-digit PIN gate staff use to unlock the scanner screen.

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

### Deploy to Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

Requires a `.firebaserc` pointing to your Firebase project. The hosting config in `firebase.json` handles SPA routing rewrites and cache headers (1-year immutable for JS/CSS assets, no-cache for `index.html` and `sw.js`).

---

## Firestore Data Model

### `visits` collection

| Field | Type | Description |
|-------|------|-------------|
| `visitorName` | string | Full name of the visitor |
| `visitorPhone` | string | Contact number |
| `relationship` | string | Relationship to student(s) |
| `purpose` | string | Reason for visit (8 categories + Other) |
| `purposeOther` | string | Free-text if purpose is "Other" |
| `students` | array | Snapshot of visited student(s) — `{studentId, studentName, class}` |
| `visitDate` | string | `YYYY-MM-DD` — QR only activates on this date |
| `status` | string | `registered` → `checked_in` → `checked_out` |
| `qrToken` | string | Unique token e.g. `VIS-A3X9K2` |
| `registeredAt` | Timestamp | When registration was submitted |
| `checkedInAt` | Timestamp | Arrival scan time |
| `checkedOutAt` | Timestamp | Departure scan time |
| `createdBy` | string | `"self"` (parent) or `"gate_staff"` (walk-in) |

> Student details are stored as a snapshot in each visit record so visit history remains intact even if a student is later removed.

### `students` collection

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Student full name |
| `class` | string | Class/grade (e.g. "Form 3A") |
| `studentId` | string | Unique student identifier (required for visitor verification) |
| `isActive` | boolean | Controls visibility in registration search |
| `createdAt` | Timestamp | When added |

---

## CSV Import Format (Students)

The Students page supports bulk import. CSV must have these headers:

```csv
name,class,studentId
Alice Johnson,Form 3A,STU-001
Bob Smith,Primary 5,STU-002
```

`studentId` is required for visitors to verify students during registration.

---

## Offline Support

The gate page is designed to work without a network connection:

1. **IndexedDB Persistence** — Firestore automatically caches reads locally
2. **Cache Warming** — On entering the scanner, today's visits and active students are pre-fetched into the local cache
3. **Optimistic UI** — Check-in/out updates the UI immediately; the write syncs to Firestore in the background
4. **Write Queuing** — If offline, writes are queued locally and replayed when reconnected
5. **Status Banner** — The gate page shows a live online/offline indicator
6. **Service Worker** — Static assets served from cache; the app loads even with no connection

---

## Authentication

| Area | Method |
|------|--------|
| Admin (`/admin/*`) | Firebase Auth — email/password. Protected via `ProtectedRoute` component. |
| Gate (`/gate`) | 4-digit PIN stored in `sessionStorage` (cleared on browser close). |
| Registration (`/register`) | No auth required. |

Staff accounts are created directly in the Firebase console (no public sign-up).

---

## Project Structure

```
src/
├── App.js                   # Route definitions
├── firebase.js              # Firebase init + Firestore persistence
├── index.js                 # Entry point + service worker registration
├── components/
│   ├── ProtectedRoute.jsx   # Auth guard for admin routes
│   └── Spinner.jsx          # Loading indicator
├── hooks/
│   └── useAuth.js           # Firebase auth state hook
├── pages/
│   ├── RegisterPage.jsx     # Visitor pre-registration
│   ├── LoginPage.jsx        # Staff login
│   ├── GatePage.jsx         # Gate scanning (check-in/out)
│   └── admin/
│       ├── AdminLayout.jsx  # Sidebar layout
│       ├── DashboardPage.jsx
│       ├── StudentsPage.jsx
│       └── VisitsPage.jsx
└── utils/
    └── generateToken.js     # QR token generator (VIS-XXXXXX)
public/
├── sw.js                    # Service worker
└── manifest.json            # PWA manifest (start_url: /gate)
```

---

## License

MIT
