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

## NOT Used

- **Netlify** — no Netlify config, functions, or redirects. Any `netlify/` or `.netlify/` directories are ignored via `.gitignore`.
