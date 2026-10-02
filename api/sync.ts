import { isAuthorized, json } from "../lib/auth.js";
import { runSync } from "../lib/sync.js";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const dryRun = ["1", "true"].includes(new URL(req.url).searchParams.get("dryRun") ?? "");
  try {
    const result = await runSync({
      calendarId: mustEnv("PB_CALENDAR_ID"),
      slug: process.env.PB_LOCATION_SLUG || "purebarre-boulder-co",
      days: Number(process.env.SYNC_DAYS || 30),
      dryRun,
    });
    return json(result, result.ok ? 200 : 500);
  } catch (err) {
    console.error("[pb-sync] fatal:", err);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
