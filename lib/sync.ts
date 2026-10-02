import { createHash } from "node:crypto";
import { addDays, fetchChunked, type PbEntry, type PbLocation } from "./pb.js";
import { deleteEvent, insertEvent, listEvents, patchEvent, type GEvent } from "./gcal.js";

export const TZ = "America/Denver";
export const SOURCE_TAG = "pb-sync";
// Bump to force a re-patch of every event after changing the mapping.
const MAPPING_VERSION = "1";
const SAFETY_RATIO = 0.3;
const WRITE_CONCURRENCY = 4;

export interface SyncConfig {
  calendarId: string;
  slug: string;
  days: number;
  dryRun: boolean;
  now?: Date;
}

interface PlanItem {
  pbId: string;
  summary: string;
  start: string;
}

export interface SyncResult {
  ok: boolean;
  dryRun: boolean;
  aborted?: string;
  window: { start: string; end: string };
  sourceCount: number;
  existingCount: number;
  counts: { inserted: number; updated: number; deleted: number; unchanged: number; failed: number };
  plan?: { insert: PlanItem[]; update: PlanItem[]; delete: PlanItem[] };
  errors: string[];
}

// ---- mapping ----

export function buildSummary(e: PbEntry): string {
  const title = e.title.replace(/Pure Barre\s*/gi, "").replace(/[™®]/g, "").trim();
  let s = e.instructor?.name ? `${title} - ${e.instructor.name.trim()}` : title;
  if (e.subtitle?.trim()) s += ` (${e.subtitle.trim()})`;
  return s;
}

export function buildLocation(loc: PbLocation | null): string {
  if (!loc) return "Pure Barre Boulder";
  const street = [loc.address, loc.address2].filter(Boolean).join(" ");
  const stateZip = [loc.state, loc.zip].filter(Boolean).join(" ");
  return [street, loc.city, stateZip].filter(Boolean).join(", ");
}

export function buildEvent(e: PbEntry, loc: PbLocation | null): GEvent {
  const summary = buildSummary(e);
  const location = buildLocation(loc);
  const description = [e.booking_url ? `Book: ${e.booking_url}` : null, e.clubready_name]
    .filter(Boolean)
    .join("\n");
  const pbHash = createHash("sha256")
    .update(JSON.stringify([MAPPING_VERSION, summary, e.starts_at, e.ends_at, location, description]))
    .digest("hex")
    .slice(0, 32);
  return {
    summary,
    start: { dateTime: e.starts_at, timeZone: TZ },
    end: { dateTime: e.ends_at, timeZone: TZ },
    location,
    description,
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { pbId: e.id, pbSource: SOURCE_TAG, pbHash } },
  };
}

// ---- time helpers ----

export function denverDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// Midnight in Denver on the given date, as an RFC3339 string with offset.
export function denverMidnight(date: string): string {
  // 07:00Z is midnight or 1am in Denver, always before the 2am DST switch, so this is the offset in effect at midnight.
  const probe = new Date(`${date}T07:00:00Z`);
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")!.value; // e.g. "GMT-06:00"
  const offset = tzName === "GMT" ? "+00:00" : tzName.replace("GMT", "");
  return `${date}T00:00:00${offset}`;
}

// ---- sync ----

export async function runSync(cfg: SyncConfig): Promise<SyncResult> {
  const now = cfg.now ?? new Date();
  const today = denverDate(now);
  const lastDay = addDays(today, cfg.days);
  const winStart = denverMidnight(today);
  const winEnd = denverMidnight(addDays(lastDay, 1));
  const winStartMs = Date.parse(winStart);
  const winEndMs = Date.parse(winEnd);

  const result: SyncResult = {
    ok: true,
    dryRun: cfg.dryRun,
    window: { start: winStart, end: winEnd },
    sourceCount: 0,
    existingCount: 0,
    counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0 },
    errors: [],
  };

  // 1. Source. Fetch one extra day past the window so end_date semantics don't matter, then clip.
  const src = await fetchChunked(cfg.slug, today, addDays(lastDay, 1));
  const desired = new Map<string, GEvent>();
  for (const e of src.entries) {
    const t = Date.parse(e.starts_at);
    if (t >= winStartMs && t < winEndMs) desired.set(e.id, buildEvent(e, src.location));
  }
  result.sourceCount = desired.size;

  // 2. Existing events, only ones this script created.
  const existing = await listEvents(cfg.calendarId, {
    timeMin: winStart,
    timeMax: winEnd,
    privateProperty: `pbSource=${SOURCE_TAG}`,
  });
  result.existingCount = existing.length;

  // 5. Safety valve, checked before any writes.
  if (desired.size === 0 || desired.size < existing.length * SAFETY_RATIO) {
    result.ok = false;
    result.aborted =
      `Source returned ${desired.size} entries vs ${existing.length} existing events ` +
      `(threshold ${Math.round(SAFETY_RATIO * 100)}%). Aborted with no changes.`;
    console.error(`[pb-sync] ABORT: ${result.aborted}`);
    return result;
  }

  // 3/4. Diff.
  const toInsert: GEvent[] = [];
  const toPatch: { id: string; ev: GEvent }[] = [];
  const toDelete: GEvent[] = [];
  const seen = new Set<string>();

  for (const ev of existing) {
    const pbId = ev.extendedProperties?.private?.pbId;
    const startMs = Date.parse(ev.start?.dateTime ?? ev.start?.date ?? "");
    const isFuture = startMs > now.getTime();
    const want = pbId ? desired.get(pbId) : undefined;
    if (!want || seen.has(pbId!)) {
      // Gone from source, or a duplicate from an interrupted earlier run. Never touch past events.
      if (isFuture) toDelete.push(ev);
      continue;
    }
    seen.add(pbId!);
    if (ev.extendedProperties?.private?.pbHash === want.extendedProperties!.private!.pbHash) {
      result.counts.unchanged++;
    } else {
      toPatch.push({ id: ev.id!, ev: want });
    }
  }
  for (const [pbId, ev] of desired) if (!seen.has(pbId)) toInsert.push(ev);

  const item = (ev: GEvent): PlanItem => ({
    pbId: ev.extendedProperties?.private?.pbId ?? "?",
    summary: ev.summary ?? "",
    start: ev.start?.dateTime ?? ev.start?.date ?? "",
  });

  if (cfg.dryRun) {
    result.counts.inserted = toInsert.length;
    result.counts.updated = toPatch.length;
    result.counts.deleted = toDelete.length;
    result.plan = {
      insert: toInsert.map(item),
      update: toPatch.map((p) => item(p.ev)),
      delete: toDelete.map(item),
    };
    console.log(`[pb-sync] DRY RUN ${JSON.stringify(result.counts)}`);
    return result;
  }

  // Apply.
  const tasks: (() => Promise<void>)[] = [
    ...toInsert.map((ev) => async () => {
      await insertEvent(cfg.calendarId, ev);
      result.counts.inserted++;
    }),
    ...toPatch.map((p) => async () => {
      await patchEvent(cfg.calendarId, p.id, p.ev);
      result.counts.updated++;
    }),
    ...toDelete.map((ev) => async () => {
      await deleteEvent(cfg.calendarId, ev.id!);
      result.counts.deleted++;
    }),
  ];
  await runPool(tasks, WRITE_CONCURRENCY, (err) => {
    result.counts.failed++;
    result.errors.push(String(err instanceof Error ? err.message : err));
  });

  if (result.counts.failed > 0) result.ok = false;
  console.log(`[pb-sync] window=${winStart}..${winEnd} source=${result.sourceCount} existing=${result.existingCount} ${JSON.stringify(result.counts)}`);
  for (const e of result.errors.slice(0, 20)) console.error(`[pb-sync] error: ${e}`);
  return result;
}

async function runPool(tasks: (() => Promise<void>)[], size: number, onError: (e: unknown) => void): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const task = tasks[i++];
      try {
        await task();
      } catch (e) {
        onError(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
}
