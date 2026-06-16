// Cloudflare Pages Function — proxies ical/public calendar URLs.
export async function onRequestGet({ request }) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) {
    return new Response('Missing url parameter', { status: 400 });
  }
  if (!url.startsWith('https://')) {
    return new Response('url must start with https://', { status: 400 });
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'ParishDesk/1.0 ICS-Proxy' },
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
  } catch (err) {
    return new Response('Failed to fetch calendar feed: ' + err.message, { status: 502 });
  }

  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
