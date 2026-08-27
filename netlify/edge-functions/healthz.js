/**
 * Netlify Edge Function for /healthz
 * Returns a tiny JSON so the fallback domain prober can measure latency.
 * The frontend fetches with {mode: 'no-cors'}, so any 200 counts as reachable,
 * but we return proper JSON for completeness.
 */
export default async (request, context) => {
  const body = JSON.stringify({
    ok: true,
    mode: "redirect",
    ts: Date.now(),
    host: request.headers.get("host") || "netlify",
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
};

export const config = {
  path: "/healthz",
};
