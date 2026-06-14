// TODO: Paste your existing Google Calendar integration code here.
// This function is called at /.netlify/functions/calendar (GET).
// During local dev with `npm run dev` (Vite only), this endpoint returns 404
// and the dashboard calendar card renders "Could not load schedule" gracefully.
// To run this function locally, use `netlify dev` instead of `npm run dev`.

export const handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  };
};
