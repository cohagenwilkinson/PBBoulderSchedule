// Minimal Google Calendar v3 client. Auth is a service account (JWT bearer) or,
// as a fallback, an OAuth client with a stored refresh token.
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export interface GEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  description?: string;
  transparency?: string;
  reminders?: { useDefault: boolean; overrides?: unknown[] };
  extendedProperties?: { private?: Record<string, string> };
}

let cachedToken: { token: string; expires: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  let body: URLSearchParams;
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    const creds = JSON.parse(sa) as { client_email: string; private_key: string; token_uri?: string };
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned =
      b64({ alg: "RS256", typ: "JWT" }) +
      "." +
      b64({
        iss: creds.client_email,
        scope: SCOPE,
        aud: creds.token_uri ?? "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      });
    const sig = createSign("RSA-SHA256").update(unsigned).sign(creds.private_key).toString("base64url");
    body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    });
  } else if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    });
  } else {
    throw new Error("No Google credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_OAUTH_* vars");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange failed (${res.status}): ${json.error_description ?? JSON.stringify(json)}`);
  }
  cachedToken = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Retries rate limits and transient 5xx with exponential backoff.
async function gfetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    const retryable =
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(await res.clone().text()));
    if (!retryable || attempt >= 5) return res;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
  }
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
}

const cal = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;

export async function listEvents(
  calendarId: string,
  opts: { timeMin: string; timeMax: string; privateProperty?: string },
): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "2500",
    });
    if (opts.privateProperty) q.set("privateExtendedProperty", opts.privateProperty);
    if (pageToken) q.set("pageToken", pageToken);
    const res = await gfetch(`${cal(calendarId)}?${q}`);
    await ensureOk(res, "events.list");
    const json = (await res.json()) as { items?: GEvent[]; nextPageToken?: string };
    out.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export async function insertEvent(calendarId: string, ev: GEvent): Promise<void> {
  const res = await gfetch(`${cal(calendarId)}?sendUpdates=none`, { method: "POST", body: JSON.stringify(ev) });
  await ensureOk(res, "events.insert");
}

export async function patchEvent(calendarId: string, eventId: string, ev: GEvent): Promise<void> {
  const res = await gfetch(`${cal(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "PATCH",
    body: JSON.stringify(ev),
  });
  await ensureOk(res, "events.patch");
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  const res = await gfetch(`${cal(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "DELETE",
  });
  // 410 Gone: already deleted, which is the outcome we want.
  if (res.status === 410) return;
  await ensureOk(res, "events.delete");
}
