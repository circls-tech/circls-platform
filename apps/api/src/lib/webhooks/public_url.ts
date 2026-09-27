import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { BadRequest } from '../errors.js';

/**
 * Addresses a webhook must never reach: private, loopback, link-local (cloud
 * metadata lives there), carrier-grade NAT, multicast, reserved and
 * documentation ranges, and every IPv6 range that carries an IPv4 address to
 * somewhere else (IPv4-compatible, SIIT, NAT64, 6to4, Teredo). IPv4-mapped
 * IPv6 addresses are unwrapped and judged as IPv4 (a ::ffff:0:0/96 rule here
 * would also catch every IPv4 address: BlockList matches IPv4 against IPv6
 * rules in that mapped form).
 */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d), or null. */
function mappedIPv4(ip: string): string | null {
  // The URL parser normalises either spelling to ::ffff:xxxx:xxxx.
  const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** Whether `ip` is an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !NOT_PUBLIC.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    return v4 !== null ? isPublicAddress(v4) : !NOT_PUBLIC.check(ip, 'ipv6');
  }
  return false;
}

/**
 * Throws BadRequest unless `raw` is an https URL whose host resolves only to
 * public addresses, so a webhook can't be aimed back into our own network.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequest('Invalid webhook URL', 'webhook_url_invalid');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequest('Webhook URLs must use https', 'webhook_url_not_https');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BadRequest('Webhook host could not be resolved', 'webhook_url_unresolvable');
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BadRequest('Webhook URLs must point to a public address', 'webhook_url_not_public');
  }
}
