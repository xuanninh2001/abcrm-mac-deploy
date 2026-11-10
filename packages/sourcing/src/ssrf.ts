import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";

/** Addresses a crawler must never reach: private, loopback, link-local (incl. cloud metadata), CGNAT, multicast, reserved. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped IPv6
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * DNS lookup used by the HTTP connector itself, so the address that is validated is the address that is
 * connected to (defeats DNS rebinding between a check and the request).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean } & object, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, []);
      const list = addresses as { address: string; family: number }[];
      const bad = allowPrivate ? undefined : list.find((a) => isBlockedAddress(a.address));
      if (bad || list.length === 0) {
        const e = new Error(`blocked address for ${hostname}`) as NodeJS.ErrnoException;
        e.code = "EBLOCKEDADDR";
        return cb(e, []);
      }
      if (options.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}
