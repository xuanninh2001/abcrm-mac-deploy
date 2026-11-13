import { request } from "node:https";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.168.0.0",16],["192.0.0.0",24],["198.18.0.0",15],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::",128],["::1",128],["fc00::",7],["fe80::",10],["ff00::",8],["64:ff9b::",96],["2002::",16]] as const) blocked.addSubnet(net, bits, "ipv6");
export function blockedRouterAddress(address: string) {
  const family = isIP(address);
  return !family || blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function normalizeRouterUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) {
    throw new Error("Use an HTTPS tunnel URL without credentials, query parameters or a custom port.");
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("Use a public HTTPS tunnel hostname.");
  }
  let path = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "");
  if (!path.endsWith("/v1")) path += "/v1";
  url.pathname = path;
  return url.toString().replace(/\/$/, "");
}

export type RouterTransport = (baseUrl: string, apiKey: string, path: "models" | "chat/completions", body?: unknown) => Promise<unknown>;

/** Validate DNS at the socket connection; never follow redirects with credentials. */
export const routerJson: RouterTransport = async (baseUrl, apiKey, path, body) => {
  const url = new URL(`${normalizeRouterUrl(baseUrl)}/${path}`);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      lookup: ((hostname: string, options: object, callback: (...args: any[]) => void) => {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err || !addresses.length || addresses.some(a => blockedRouterAddress(a.address))) return callback(new Error("Blocked tunnel address"));
          if ((options as { all?: boolean }).all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      }) as never,
    }, res => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const status = res.statusCode ?? 0;
        reject(new Error(`9router HTTP ${status}. ${status === 401 || status === 403 ? "Check API key and tunnel access rules." : status === 429 ? "Provider quota or rate limit reached." : "Check tunnel URL, model and provider in 9router."}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error("9router response is too large.")); return; }
        chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("9router response interrupted.")));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("9router did not return JSON. Check the API URL and Cloudflare Access rules.")); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("9router request timed out.")); }, 120_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("Cannot connect securely to the 9router tunnel. Check DNS, HTTPS and tunnel status.")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
};
