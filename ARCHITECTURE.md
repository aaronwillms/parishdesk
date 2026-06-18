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

## Directory clergy field

`personnel.clergy` (boolean, set in the Add/Edit Person dialog) is the **single
source of truth** for whether a directory contact is clergy. The directory lists
clergy at the top of each institution with a "Clergy" chip; `getInstitutionClergy(institutionId)`
([src/ui/directory.js](src/ui/directory.js)) is the one shared helper that
clergy-aware dropdowns (e.g. the sacramental "Officiant" picker) consume — wired
in a later task. (An earlier experiment deriving clergy/placement from HR
positions was reverted; HR positions no longer drive the directory's clergy
determination.)

## NOT Used

- **Netlify** — no Netlify config, functions, or redirects. Any `netlify/` or `.netlify/` directories are ignored via `.gitignore`.
