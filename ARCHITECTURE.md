# ParishDesk Architecture

## Hosting

**Cloudflare Pages** — the sole hosting and serverless platform.

- Static frontend served from `dist/` (built by Vite)
- Serverless functions in `functions/` (Cloudflare Pages Functions)
- All environment variables set in the Cloudflare Pages dashboard

## Frontend

- **Vite** — build tool, dev server
- **Vanilla JS** — no framework; panels in `src/panels/`, UI components in `src/ui/`
- Entry point: `index.html` → `src/main.js`

## Backend / Data

- **Supabase** — PostgreSQL database with Row Level Security, Auth, and Storage
- Frontend accesses Supabase via the `@supabase/supabase-js` client (`src/supabase.js`)
- Cloudflare Functions access Supabase directly via REST API using `SUPABASE_SERVICE_KEY`

## Cloudflare Pages Functions

All files under `functions/` are Cloudflare Pages Functions, served at `/functions/<name>`.

| File | Route | Purpose |
|------|-------|---------|
| `functions/admin-users.js` | `/functions/admin-users` | List all Supabase auth users merged with profiles |
| `functions/calendar.js` | `/functions/calendar` | Proxy public ical/calendar URLs (CORS bypass) |
| `functions/config.js` | `/functions/config` | Expose public env vars to the frontend |
| `functions/google-calendar-proxy.js` | `/functions/google-calendar-proxy` | Proxy Google Calendar API using stored OAuth tokens |
| `functions/invite-user.js` | `/functions/invite-user` | Send Supabase invite email to a new user |
| `functions/auth/google/callback.js` | `/functions/auth/google/callback` | Handle Google OAuth callback, store tokens in Supabase |

## Environment Variables (Cloudflare Pages)

| Variable | Used by |
|----------|---------|
| `VITE_SUPA_URL` | Frontend + all Functions |
| `VITE_SUPA_ANON_KEY` | Frontend |
| `SUPABASE_SERVICE_KEY` | All Functions (service role, bypasses RLS) |
| `GOOGLE_CLIENT_ID` | `config.js`, `auth/google/callback.js` |
| `GOOGLE_CLIENT_SECRET` | `auth/google/callback.js` |

## Sacramental master-detail shell

The six sacramental panels share one reusable, config-driven split-pane shell
(`src/sacramental/panelShell.js`). Each panel supplies a config object; the shell
owns layout, the list pane, the read-first detail pane, hash deep-linking,
responsive behavior, and bulk-select. Baptism is migrated
(`src/sacramental/baptismConfig.js`); the other five migrate later by writing a
config file only — no shell changes.

- **Mount:** a panel's loader fetches data, then calls
  `renderSacramentalPanel(containerEl, config)` (Baptism mounts into
  `#baptism-root` from `loadBaptism()`).
- **Routing:** hash-based, `#/<panelKey>` (list) and `#/<panelKey>/:id` (file
  open); shareable, survives refresh. `openSacramentalRecord(panelKey, id)` is
  the public deep-link hook (the future `#`-mention case-linking calls it).
- **Theming:** uses the existing CSS variables/tokens and `.sac-*` classes with
  explicit light + dark rules in `main.css`. No hardcoded hex in the shell.

### Cohort grouping (groupBy / groupLabel — live as of First Communion)

When a config sets `groupBy`, the shell renders **collapsible groups** instead of a
flat list (First Communion groups by cohort; Baptism stays flat). The grouping
path: groups are ordered by the config's `groupCompare` (most-recent first), the
**newest group is expanded and older groups collapsed by default** (UI-only,
not persisted), records with no group fall into an **"Unassigned" group pinned
last** (never dropped), and an **active search auto-expands** so matches show
across every group. Bulk-select works across groups and selection survives
collapse toggles. The flat-list path (Baptism) is unchanged.

### Sacramental preparer vs. officiant

`officiant` is a per-record field for **Baptism and Marriage only** (the minister
who performs the rite). The **initiation panels (First Communion, and
Confirmation later) are preparer-only** — no officiant field. The **preparer**
dropdown is a shared, reusable helper (`src/sacramental/preparerField.js`):
options are institution clergy (`getInstitutionClergy`) + the panel's sacramental
coordinator(s) + an "Other…" free entry; the chosen display name is stored on the
record and shown in the read view. Each panel supplies its own coordinator source.

### Config schema (the contract a panel implements)

| Key | Type | Purpose |
|-----|------|---------|
| `panelKey`, `title`, `newLabel` | string | identity + list header |
| `groupBy(record)` / `groupLabel(key)` | fn / null | collapsible groups (cohort panels); `null` = flat list |
| `canManage()`, `canManageTemplate()` | fn→bool | role gating (New/Edit/bulk; settings gear) |
| `openCreate()`, `openTemplate()` | fn | New button / settings gear actions |
| `fetchRecords()` / `fetchRecord(id)` | fn | data source (reuse existing Supabase fetch) |
| `searchText(record)` | fn→string | client-side search field |
| `statusFilters[]` | `{key,label,match(record)}` | filter pills |
| `listItem(record)` | `{title, secondary?, chips[], flags[]}` | list card; chips = `{label,tone}`, flags = `{icon,tone,label,short?}` |
| `detailHeader(record)` | `{initials,name,chips[],flags[]}` | detail header |
| `actions[]` | `{label,icon?,handler(record)}` | header actions (e.g. Email) |
| `detailSections[]` | `{title, render(record)→html}` | read-only detail body |
| `editForm(record)` | fn→html | the EXISTING edit form, inline (no modal chrome) |
| `saveRecord(id)` / `deleteRecord(id)` | async fn→`{ok,record?}` | persist + log via existing logic |
| `bulkStatusOptions[]`, `bulkUpdateStatus(ids,key)` | array / async fn | bulk status change |

## HR position tree

- **Where institutions + roots come from:** institutions, AND their permanent
  root position, are created **only** in the directory's add-institution flow
  (`saveInstitution()` in `src/panels/personnel.js`). HR **consumes** the
  institution list — it can rename/reorder tabs but has no "+ Institution"
  button and never inserts a root. This is the single root-creation path.
- **Permanent root:** each institution has exactly ONE root position
  (`parent_position_id IS NULL`), auto-created as "Root Administrator" when the
  institution is created. It is editable and linkable but **never deleted,
  moved, or archived** (those would break the one-root invariant); the delete
  affordance is disabled with an explanatory tooltip. A partial unique index
  (`uniq_positions_root_per_institution`) enforces this in the DB. There is no
  manual root-creation button — children are added under any position via
  "+ Child".
- **Tree default state:** the position tree renders FULLY EXPANDED on load and
  on refresh. A module-level `_collapsed` set tracks nodes the user manually
  collapsed during the session (open unless present); it intentionally does not
  persist — a refresh resets the module and the tree re-opens fully.
- **Reparent on delete:** deleting a non-root position **reparents its children
  to that position's parent** (never orphans a node); the confirmation names the
  children and their destination. Positions with occupancy history are
  archive-only (records FK to `person_position_id`).
- **Unlink** is a soft clear (`person_positions.unlinked_at`), preserving record
  + succession history; it removes only the current occupancy, not the position
  or the person.

## Directory clergy field

`personnel.clergy` (boolean, set in the Add/Edit Person dialog) is the **single
source of truth** for whether a directory contact is clergy. The directory lists
clergy at the top of each institution with a "Clergy" chip; `getInstitutionClergy(institutionId)`
([src/ui/directory.js](src/ui/directory.js)) is the one shared helper that
clergy-aware dropdowns (e.g. the sacramental "Officiant" picker) consume — wired
in a later task. (An earlier experiment deriving clergy/placement from HR
positions was reverted; HR positions no longer drive the directory's clergy
determination.)

## Institution display order

Institutions render in a single **global, parish-wide order** held in
`institutions.sort_order` (everyone sees the same order; HR and the directory
both load `.order('sort_order')`). The order is arranged from the **HR panel's
‹ › arrows** (gated to admin/super-admin) — the one canonical control; there is
no manual sort-order field in the directory modals. New institutions **append to
the end** (`max(sort_order)+1`).

## Permission basis model (Admin > Users)

A team / institution(panel) / sacrament permission can be held on more than one
**basis** at once; tracking WHY keeps locks and removals correct and
non-destructive. Computed centrally in `computePermissionBasis()`
([src/roles.js](src/roles.js)) — the UI reads the result and never hand-derives
locks.

- **manual** — an admin set the toggle (a row in `panel_grants` / `team_members`
  / `sacramental_roles`).
- **admin** — derived from the user being Admin; covers ALL team + institution
  perms (NOT sacraments).
- **role** — derived from a sacramental coordinator assignment
  (`program_coordinators`); covers that one sacrament.

A permission is effectively granted if ANY basis is present. **Derived bases
(admin/role) are never written into the manual tables**, so removal is inherently
non-destructive: dropping Admin or a coordinator role removes only that basis and
any manual grant survives (toggle returns to editable); a permission with no
remaining basis turns off. The save persists manual intent only and leaves
derived-locked (disabled) rows untouched. No schema change — basis is derivable
from the existing distinct sources.

Three visually distinct toggle states: **editable** (interactive), **locked by
Admin** (ON + disabled, navy "🔒 Admin" chip, tooltip "Granted by Admin role"),
**locked by coordinator** (ON + disabled, cardinal "🔒 [Sacrament] coordinator"
chip, tooltip "Granted by [Sacrament] coordinator role"). Locks are additive and
independent — a coordinator-who-is-also-Admin shows team+institution locked by
admin AND their one sacrament locked by role, other sacraments still editable.

## Phone numbers

Phones are **stored as normalized digits** and formatted on input and display via
the one shared helper `src/utils/phone.js` (`formatPhone`, `normalizePhone`,
`attachPhoneMask`). `installPhoneMask()` (called once at boot in `main.js`) uses a
MutationObserver to attach the live, caret-stable mask to every `input[type="tel"]`
as forms are injected — no per-field wiring. Saves pass through `normalizePhone`;
displays through `formatPhone` (which degrades gracefully, leaving non-10-digit
values untouched). No data migration is required — the formatter re-derives from
digits.

## NOT Used

- **Netlify** — no Netlify config, functions, or redirects. Any `netlify/` or `.netlify/` directories are ignored via `.gitignore`.
