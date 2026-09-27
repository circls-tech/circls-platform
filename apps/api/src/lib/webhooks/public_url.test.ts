import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, isPublicAddress } from './public_url.js';

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local and mapped addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.5',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses IPv6 ranges that carry an IPv4 address elsewhere, and other non-public ones', () => {
    for (const ip of [
      '::127.0.0.1', // IPv4-compatible
      '::a9fe:a9fe',
      '::ffff:0:7f00:1', // SIIT
      '64:ff9b::a9fe:a9fe', // NAT64
      '64:ff9b:1::a9fe:a9fe', // local-use NAT64
      '2002:a9fe:a9fe::1', // 6to4
      '2001:0:a9fe:a9fe::1', // Teredo
      'fec0::1',
      '100::1',
      '3fff::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('accepts public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses what is not an address', () => {
    expect(isPublicAddress('example.com')).toBe(false);
  });
});

describe('assertPublicHttpsUrl', () => {
  const code = async (url: string) => {
    try {
      await assertPublicHttpsUrl(url);
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };

  it('wants https', async () => {
    expect(await code('http://93.184.216.34/hook')).toBe('webhook_url_not_https');
  });

  it('refuses hosts that resolve inside the network', async () => {
    expect(await code('https://127.0.0.1/hook')).toBe('webhook_url_not_public');
    expect(await code('https://169.254.169.254/latest/meta-data')).toBe('webhook_url_not_public');
    expect(await code('https://[::1]/hook')).toBe('webhook_url_not_public');
    expect(await code('https://[::127.0.0.1]/hook')).toBe('webhook_url_not_public');
  });

  it('accepts a public https address', async () => {
    expect(await code('https://93.184.216.34/hook')).toBe('ok');
  });

  it('refuses what is not a URL', async () => {
    expect(await code('not a url')).toBe('webhook_url_invalid');
  });
});
