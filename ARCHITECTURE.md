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
last** (never dropped; a config may rename it via `noneLabel`), and an **active
search auto-expands** so matches show across every group. Bulk-select works across
groups and selection survives collapse toggles. The flat-list path (Baptism) is
unchanged.

**Two-level grouping (optional, live as of Confirmation).** A config may add a
second level with `subGroupBy(record)` + `subGroupLabel(subKey, parentKey)` (and
optional `subGroupOrder`). Each top-level group then renders **sub-sections** in
`subGroupOrder`, with a lighter secondary header showing each sub-section's own
count (the cohort header shows the group total); only sub-sections with members
render. The parent group's collapse still collapses the whole group, and
archived-last applies within each sub-section. Configs that don't set
`subGroupBy` (First Communion) render exactly as before — single-level output is
unchanged. Confirmation uses this: **cohort** (top) then **youth/adult** (sub);
uncohorted candidates use `noneLabel: 'No Cohort'` with sub-sections "Youth
Candidates" / "Adult Candidates" (never a bare "Unassigned").

Detail sections may carry an optional `when(record)` predicate; a section renders
only when it returns truthy. Confirmation's **Service Hours** section is
`when: youth && hours-enabled` — shown for youth candidates only, hidden entirely
for adults (the edit form's service-hours field is likewise youth-gated).

### First Communion cohorts — created in the panel, selected in Add Student

Cohort **creation** lives in the First Communion panel via a **Manage Cohorts**
button (calendar icon) in the shell list header, gated to `canManageTemplate()`
(the same role that manages templates). It opens the existing cohort manager
(`openCohortManager` → `fcSaveCohort`, writing `sacramental_cohorts` with
`panel='firstcomm'`) — unchanged; only the launch point moved here. The header
button is driven by an optional `config.openManageCohorts` hook, so panels that
don't set it (Baptism, etc.) are unaffected. The **Add Student** modal only
**selects** an existing cohort from a plain dropdown (no create option); with no
cohorts it shows a disabled empty state pointing to Manage Cohorts — Add Student
is never a back-door to cohort creation.

### Shell sort — upcoming-date + archived-last

Two parameterized, shell-level sort behaviors (in `panelShell.js`), keyed to the
**existing `archived` boolean** that every sacramental table already uses
(`couples`, `sacramental_baptism`, `sacramental_firstcomm`) — the shell never
invents a new archive flag:

- **`sortByDate: '<field>'`** (flat panels) — sorts the active list by that date
  field: records with **no date at the top** (active work needing scheduling),
  then **upcoming soonest-first**, then **past most-recent-first**. Marriage uses
  `wedding_date`, Baptism uses `baptism_date`.
- **Archived-last** (automatic, every panel) — `archived` records always sort
  **below** active ones. On flat panels they form a bottom **"Archived"** cluster
  (most-recent first); within First Communion's groups, archived records sink to
  the bottom of their group while non-archived order is unchanged.

A flat panel with neither `sortByDate` nor any archived records renders the exact
old flat list; First Communion's grouped output is unchanged except that archived
records (if any) move to the end of their group.

### Sacramental preparer vs. officiant

`officiant` is a per-record field for **Baptism and Marriage only** (the minister
who performs the rite). The **initiation panels (First Communion, and
Confirmation later) are preparer-only** — no officiant field. Two shared,
reusable dropdown helpers back these:

- **Officiant** (`src/sacramental/officiantField.js`): clergy + "Other…" free
  entry. Built for Marriage; Baptism reuses it later.
- **Preparer** (`src/sacramental/preparerField.js`): clergy + the panel's
  sacramental coordinator(s) + "Other…". Each panel supplies its coordinator
  source (Marriage passes the marriage coordinator).

Both store the chosen **display-name string** and show it in the read view. Their
clergy roster comes from the shared `clergyNames()` helper, which sources
`personnel.clergy` **parish-wide** (a person-level boolean) — institution
membership is HR-derived since Move 2 and no longer on `personnel`, so the
previous per-institution `getInstitutionClergy()` scoping was retired from these
helpers.

### Marriage — couple-keyed subject + wedding-date sort

Marriage is the **first couple-keyed panel** (the subject is a couple, not one
person) and the first to use the officiant dropdown. `marriageConfig.js`:
`listItem`/`detailHeader` title = "Groom & Bride" (full names); the detail avatar
shows a two-person pair (e.g. "AW·JD"). It is a **flat list** (`groupBy: null`)
**sorted by wedding date, upcoming-first**: files with **no date set** (active
early-stage prep) sort at the very top, then **upcoming soonest→latest**, then
**past most-recent→oldest**, then archived/inactive last. New `couples.officiant`
and `couples.preparer` text columns back the two dropdowns (migration paused); the
new officiant field replaced the legacy inline select and is seeded from the
legacy `officiant_id`/`officiant_override`, which (with `officiant_override`)
become dead columns for a later cleanup.

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

## Institution membership — HR is the sole owner

A person's institution membership is **derived from HR**, not stored on the
directory record. HR (`person_positions` → `positions.institution_id`) is the
single source of truth: the directory ([src/panels/personnel.js](src/panels/personnel.js))
reads each person's **active** `person_positions` (`unlinked_at IS NULL`) whose
`positions` are active (`archived_at IS NULL`), maps `institution_id → name`, and
renders the person under **every** institution they hold a position in (multiple
appearances for multiple institutions). The Full/Part/Contract sub-grouping is
**per-position**, from `person_positions.employment_type`
(`full_time`/`part_time`/`contract`). A person with **no** active position appears
once under **Volunteer**; there is no "Unassigned" bucket. Person-level facts —
the **Clergy** chip (`personnel.clergy`) and **coordinator** chips
(`program_coordinators`) — show on every appearance; clergy sort to the top of
each institution group.

The Add/Edit Person form writes **person-level fields only** (name, phone, email,
DOB, clergy, active). It no longer has Type/Employment/Institution dropdowns —
those assignments are made in HR.

**Dead columns (pending a later cleanup task):** `personnel.institution`,
`personnel.type`, `personnel.employment` are no longer read or written by the
directory and hold stale values (e.g. the legacy `institution = "Parish"`). They
are intentionally NOT migrated/dropped yet. `personnel.type` is still seeded to
`'staff'` on insert only, as a guard against a possible legacy NOT NULL — remove
when the columns are dropped. (Note: `src/ui/contactPicker.js` still writes these
columns when creating a contact; harmless dead writes, to be cleaned up with the
columns.)

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
both load `.order('sort_order')`). It is **one value editable from two places** —
the **HR panel's ‹ › arrows** and the **Directory's ▲▼ arrows** — both gated to
admin/super-admin and both renumbering the same `sort_order` column (reorder in
either surface is reflected in the other). There is no second Directory-specific
order and no manual sort-order field. New institutions **append to the end**
(`max(sort_order)+1`).

## Coordinator chip labels

A directory person shows a coordinator chip for each program they **actually
coordinate** — sourced from `program_coordinators.coordinator_ids` (an array of
personnel ids), keyed **directly by personnel id, no user link required**. Panel
access (`sacramental_roles` / `panel_grants`) does NOT grant a chip — access is
not coordination. The chip wording lives in a single shared map,
`SACRAMENT_COORDINATOR_LABELS` in [src/roles.js](src/roles.js) (with
`coordinatorChipLabels()`), so every surface uses the exact same labels — e.g.
Marriage → "Wedding Coordinator". The map is the complete set; a program with no
entry (annulments) produces no chip by design, with no generic fallback. (The
map keys First Communion as `first_communion`; `program_coordinators` uses
`firstcomm`, so the directory translates that one key when building the source.)
Chips are person-level: they render on every directory appearance of the person.

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
