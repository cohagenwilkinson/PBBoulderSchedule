// Exercises runSync against in-memory fakes of the PB API and Google Calendar.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildSummary, runSync } from "../lib/sync.js";
import type { GEvent } from "../lib/gcal.js";
import type { PbEntry } from "../lib/pb.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "x@y.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const NOW = new Date("2026-10-02T18:00:00Z"); // noon in Denver
const loc = { address: "1 Test St", address2: "Suite 2", city: "Boulder", state: "CO", zip: "80302" };

function entry(id: string, start: string, extra: Partial<PbEntry> = {}): PbEntry {
  const s = new Date(start);
  return {
    id,
    title: "Pure Barre Classic™",
    subtitle: null,
    starts_at: s.toISOString(),
    ends_at: new Date(s.getTime() + 50 * 60_000).toISOString(),
    instructor: { name: "Giulia D." },
    clubready_name: "Classic",
    booking_url: `https://example.com/book/${id}`,
    ...extra,
  };
}

let source: PbEntry[] = [];
let calendar: GEvent[] = [];
let nextId = 1;
const writes: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.hostname === "members.purebarre.com") {
    const s = url.searchParams.get("start_date")!, e = url.searchParams.get("end_date")!;
    const inRange = source.filter((x) => x.starts_at.slice(0, 10) >= s && x.starts_at.slice(0, 10) <= e);
    return ok({ schedule_entries: inRange, locations: [loc] });
  }
  if (url.hostname === "oauth2.googleapis.com") return ok({ access_token: "t", expires_in: 3600 });
  const m = url.pathname.match(/\/events(?:\/([^/]+))?$/)!;
  const id = m[1] && decodeURIComponent(m[1]);
  if (method === "GET") {
    const prop = url.searchParams.get("privateExtendedProperty");
    const [k, v] = prop ? prop.split("=") : [];
    const tMin = Date.parse(url.searchParams.get("timeMin")!), tMax = Date.parse(url.searchParams.get("timeMax")!);
    const items = calendar.filter((ev) => {
      const st = Date.parse(ev.start!.dateTime!), en = Date.parse(ev.end!.dateTime!);
      return (!prop || ev.extendedProperties?.private?.[k] === v) && en > tMin && st < tMax;
    });
    return ok({ items });
  }
  writes.push(`${method} ${id ?? ""}`);
  if (method === "POST") { calendar.push({ ...JSON.parse(String(init!.body)), id: `g${nextId++}` }); return ok({}); }
  const idx = calendar.findIndex((ev) => ev.id === id);
  if (method === "PATCH") { calendar[idx] = { ...calendar[idx], ...JSON.parse(String(init!.body)) }; return ok({}); }
  if (method === "DELETE") { calendar.splice(idx, 1); return new Response(null, { status: 204 }); }
  throw new Error("unexpected");
}) as typeof fetch;

const cfg = { calendarId: "cal", slug: "s", days: 30, dryRun: false, now: NOW };

// Summary formatting
assert.equal(buildSummary(entry("a", "2026-10-03T14:00:00Z")), "Classic - Giulia D.");
assert.equal(buildSummary(entry("a", "2026-10-03T14:00:00Z", { subtitle: "New Clients Only" })), "Classic - Giulia D. (New Clients Only)");
assert.equal(buildSummary(entry("a", "2026-10-03T14:00:00Z", { title: "Pure Barre Focus™", instructor: null })), "Focus");

// Unmarked user event in the window must never be touched.
calendar.push({ id: "mine", summary: "Personal", start: { dateTime: "2026-10-05T15:00:00Z" }, end: { dateTime: "2026-10-05T16:00:00Z" } });

// Initial sync: 40 classes, including two overlapping in one slot and one earlier today.
source = Array.from({ length: 40 }, (_, i) => entry(`cr_${i}`, new Date(Date.parse("2026-10-02T13:00:00Z") + i * 17 * 3600_000).toISOString()));
source.push(entry("cr_overlap", source[5].starts_at, { title: "Pure Barre Engage™", subtitle: "Intro" }));
source.push(entry("cr_far", "2026-11-20T15:00:00Z")); // outside window
let r = await runSync(cfg);
assert.equal(r.counts.inserted, 41, JSON.stringify(r));
assert.equal(calendar.length, 42);

// Second run with no changes: all unchanged, zero writes.
writes.length = 0;
r = await runSync(cfg);
assert.deepEqual(r.counts, { inserted: 0, updated: 0, deleted: 0, unchanged: 41, failed: 0 });
assert.equal(writes.length, 0);

// Change instructor on one, cancel a future one and the past one (earlier today), add a new one.
source[3] = { ...source[3], instructor: { name: "Sam K." } };
const cancelledFuture = source.splice(10, 1)[0];
const cancelledPast = source.splice(0, 1)[0]; // 07:00 Denver today, already started
source.push(entry("cr_new", "2026-10-20T16:00:00Z"));

const before = JSON.stringify(calendar);
const dry = await runSync({ ...cfg, dryRun: true });
assert.deepEqual([dry.counts.inserted, dry.counts.updated, dry.counts.deleted], [1, 1, 1]);
assert.equal(dry.plan!.delete[0].pbId, cancelledFuture.id);
assert.equal(JSON.stringify(calendar), before, "dry run must not write");

r = await runSync(cfg);
assert.deepEqual(r.counts, { inserted: 1, updated: 1, deleted: 1, unchanged: 38, failed: 0 });
assert.ok(calendar.some((e) => e.summary === "Classic - Sam K."));
assert.ok(calendar.some((e) => e.extendedProperties?.private?.pbId === cancelledPast.id), "past event kept");
assert.ok(calendar.some((e) => e.id === "mine"), "unmarked event untouched");

// Duplicate (interrupted earlier run) gets cleaned up.
calendar.push({ ...calendar.find((e) => e.extendedProperties?.private?.pbId === "cr_new")!, id: "dupe" });
r = await runSync(cfg);
assert.equal(r.counts.deleted, 1);

// Safety valve: outage returns nothing, then a partial response.
const saved = source;
source = [];
writes.length = 0;
r = await runSync(cfg);
assert.equal(r.ok, false); assert.ok(r.aborted); assert.equal(writes.length, 0);
source = saved.slice(0, 5);
r = await runSync(cfg);
assert.equal(r.ok, false); assert.equal(writes.length, 0);

console.log("all sync tests passed");
