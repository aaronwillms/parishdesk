// Cloudflare Pages Function — exposes public env vars to the frontend.
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    googleClientId: env.GOOGLE_CLIENT_ID || '',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
