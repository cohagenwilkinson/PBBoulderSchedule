// Build-order checks 1-3. GET /api/probe?mode=source|range|calendar
//   source:   one 7-day request, returns the count (confirms Vercel isn't blocked)
//   range:    one 30-day request vs 7-day chunks, compares id sets
//   calendar: lists the target calendar to confirm Google auth and sharing
import { isAuthorized, json } from "../lib/auth.js";
import { addDays, fetchChunked, fetchRange } from "../lib/pb.js";
import { listEvents } from "../lib/gcal.js";
import { denverDate, denverMidnight } from "../lib/sync.js";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const mode = new URL(req.url).searchParams.get("mode") ?? "source";
  const slug = process.env.PB_LOCATION_SLUG || "purebarre-boulder-co";
  const days = Number(process.env.SYNC_DAYS || 30);
  const today = denverDate(new Date());
  try {
    if (mode === "source") {
      const r = await fetchRange(slug, today, addDays(today, 7));
      const starts = r.entries.map((e) => e.starts_at).sort();
      return json({ ok: true, count: r.entries.length, first: starts[0], last: starts.at(-1), sample: r.entries[0], location: r.location });
    }
    if (mode === "raw") {
      // Diagnoses blocking: tries the request with a few header sets and reports status, block headers and page title.
      const url = `https://members.purebarre.com/api/v2/locations/${slug}/schedule_entries?start_date=${today}&end_date=${addDays(today, 7)}`;
      const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
      const base = { accept: "application/json", origin: "https://www.purebarre.com", referer: "https://www.purebarre.com/location/boulder-co", "user-agent": ua };
      const variants: Record<string, Record<string, string>> = {
        bare: {},
        brief: base,
        fullBrowser: {
          ...base,
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          "sec-ch-ua": '"Chromium";v="129", "Not=A?Brand";v="8", "Google Chrome";v="129"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        },
      };
      const out: Record<string, unknown> = {};
      for (const [name, headers] of Object.entries(variants)) {
        const res = await fetch(url, { headers });
        const text = await res.text();
        out[name] = {
          status: res.status,
          server: res.headers.get("server"),
          cfRay: res.headers.get("cf-ray"),
          cfMitigated: res.headers.get("cf-mitigated"),
          title: text.match(/<title>([^<]*)<\/title>/)?.[1],
          cfError: text.match(/Error code:?\s*<?[^>]*>?\s*(\d{3,4})/i)?.[1] ?? text.match(/cf-error-code[^>]*>(\d+)/)?.[1],
          snippet: res.ok ? text.slice(0, 120) : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400),
        };
      }
      const ip = await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => "?");
      return json({ egressIp: ip, region: process.env.VERCEL_REGION, results: out });
    }
    if (mode === "range") {
      const end = addDays(today, days);
      const single = await fetchRange(slug, today, end).catch((e: Error) => ({ error: e.message, entries: [] as { id: string; starts_at: string }[] }));
      const chunked = await fetchChunked(slug, today, end);
      const singleIds = new Set(single.entries.map((e) => e.id));
      const chunkIds = new Set(chunked.entries.map((e) => e.id));
      const lastStart = (xs: { starts_at: string }[]) => xs.map((e) => e.starts_at).sort().at(-1);
      return json({
        ok: true,
        range: `${today}..${end}`,
        single: { count: single.entries.length, last: lastStart(single.entries), error: "error" in single ? single.error : undefined },
        chunked: { count: chunked.entries.length, requests: chunked.requests, last: lastStart(chunked.entries) },
        missingFromSingle: [...chunkIds].filter((id) => !singleIds.has(id)).length,
        missingFromChunked: [...singleIds].filter((id) => !chunkIds.has(id)).length,
      });
    }
    if (mode === "calendar") {
      const calendarId = process.env.PB_CALENDAR_ID;
      if (!calendarId) return json({ ok: false, error: "PB_CALENDAR_ID not set" }, 500);
      const events = await listEvents(calendarId, { timeMin: denverMidnight(today), timeMax: denverMidnight(addDays(today, days + 1)) });
      const managed = events.filter((e) => e.extendedProperties?.private?.pbSource === "pb-sync").length;
      return json({ ok: true, totalEvents: events.length, managedBySync: managed, unmanaged: events.length - managed });
    }
    return json({ error: `unknown mode ${mode}` }, 400);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
