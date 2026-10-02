// Failure alerts and a success heartbeat. Both optional; unset = no-op.
//
//   ALERT_WEBHOOK_URL  POSTed on failure. Slack incoming webhooks get {"text": ...};
//                      anything else (e.g. https://ntfy.sh/<topic>) gets the message as plain text.
//   HEARTBEAT_URL      GET on success (e.g. a healthchecks.io check). The heartbeat service
//                      alerts when a ping is missed, which catches the cron not running at all.

export async function alertFailure(title: string, detail: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const message = `${title}\n${detail}`.slice(0, 3000);
  const isSlack = url.includes("hooks.slack.com");
  try {
    await fetch(url, {
      method: "POST",
      headers: isSlack ? { "content-type": "application/json" } : { title, priority: "high", tags: "warning" },
      body: isSlack ? JSON.stringify({ text: message }) : message,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[alert] failed to send alert:", err);
  }
}

export async function heartbeat(): Promise<void> {
  const url = process.env.HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error("[alert] heartbeat failed:", err);
  }
}
