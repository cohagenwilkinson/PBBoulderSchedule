// Pure Barre public schedule API client.

import { egressFetch } from "./egress.js";

export interface PbEntry {
  id: string;
  title: string;
  subtitle: string | null;
  starts_at: string;
  ends_at: string;
  instructor: { name: string } | null;
  clubready_name: string | null;
  booking_url: string | null;
}

export interface PbLocation {
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface PbSchedule {
  entries: PbEntry[];
  location: PbLocation | null;
}

const HEADERS = {
  accept: "application/json",
  origin: "https://www.purebarre.com",
  referer: "https://www.purebarre.com/location/boulder-co",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};

export async function fetchRange(slug: string, startDate: string, endDate: string): Promise<PbSchedule> {
  const url =
    `https://members.purebarre.com/api/v2/locations/${encodeURIComponent(slug)}/schedule_entries` +
    `?start_date=${startDate}&end_date=${endDate}`;
  const res = await egressFetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PB API ${res.status} for ${startDate}..${endDate}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { schedule_entries?: PbEntry[]; locations?: PbLocation[] };
  if (!Array.isArray(json.schedule_entries)) {
    throw new Error(`PB API returned no schedule_entries array for ${startDate}..${endDate}`);
  }
  return { entries: json.schedule_entries, location: json.locations?.[0] ?? null };
}

// Fetches [startDate, endDate] in chunks of chunkDays. Chunks overlap by one day so the
// result is correct whether the API treats end_date as inclusive or exclusive; dedupe by id.
export async function fetchChunked(
  slug: string,
  startDate: string,
  endDate: string,
  chunkDays = 7,
): Promise<PbSchedule & { requests: number }> {
  const byId = new Map<string, PbEntry>();
  let location: PbLocation | null = null;
  let requests = 0;
  for (let d = startDate; d < endDate; d = addDays(d, chunkDays)) {
    const chunkEnd = minDate(addDays(d, chunkDays), endDate);
    const page = await fetchRange(slug, d, chunkEnd);
    requests++;
    location ??= page.location;
    for (const e of page.entries) byId.set(e.id, e);
  }
  return { entries: [...byId.values()], location, requests };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
