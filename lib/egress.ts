// Outbound HTTP that can route through a residential proxy, for sites that block
// cloud/datacenter IPs (e.g. Cloudflare rules on purebarre.com).
//
// Self-contained so it can be copied into other projects. Only dependency: undici.
//
// Config:
//   RESIDENTIAL_PROXY_URL  http://user:pass@host:port  (unset = direct)
//
// Usage:
//   egressFetch(url, init)                    -> proxy if configured, else direct
//   egressFetch(url, init, { via: "direct" }) -> never proxy
//   egressFetch(url, init, { via: "proxy" })  -> throws if no proxy configured
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from "undici";

export type Via = "auto" | "proxy" | "direct";

const agents = new Map<string, ProxyAgent>();

function proxyUrl(): string | undefined {
  return process.env.RESIDENTIAL_PROXY_URL?.trim() || undefined;
}

export function proxyConfigured(): boolean {
  return Boolean(proxyUrl());
}

function agentFor(url: string): ProxyAgent {
  let agent = agents.get(url);
  if (!agent) {
    // undici wants credentials as a Proxy-Authorization token, not embedded in the URI.
    const u = new URL(url);
    const token = u.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`
      : undefined;
    u.username = "";
    u.password = "";
    agent = new ProxyAgent({ uri: u.toString(), token });
    agents.set(url, agent);
  }
  return agent;
}

export async function egressFetch(
  url: string,
  init: UndiciRequestInit = {},
  opts: { via?: Via; timeoutMs?: number } = {},
): Promise<Response> {
  const via = opts.via ?? "auto";
  const proxy = proxyUrl();
  if (via === "proxy" && !proxy) throw new Error("egressFetch: via=proxy but RESIDENTIAL_PROXY_URL is not set");
  const useProxy = via !== "direct" && Boolean(proxy);
  const res = await undiciFetch(url, {
    ...init,
    dispatcher: useProxy ? agentFor(proxy!) : undefined,
    signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  return res as unknown as Response;
}

// Public IP as seen by the outside world, for confirming which path traffic takes.
export async function egressIp(via: Via = "auto"): Promise<string> {
  const res = await egressFetch("https://api.ipify.org?format=json", {}, { via, timeoutMs: 15_000 });
  return ((await res.json()) as { ip: string }).ip;
}
