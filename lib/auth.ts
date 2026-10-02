import { timingSafeEqual } from "node:crypto";

// Vercel cron sends "Authorization: Bearer $CRON_SECRET". A ?secret= query param is also
// accepted for manual runs from a browser.
export function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const query = new URL(req.url).searchParams.get("secret") ?? "";
  return safeEqual(header, `Bearer ${secret}`) || safeEqual(query, secret);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
