export type IpAddressFamily = 'ipv4' | 'ipv6';

export type Ipv4Address = [number, number, number, number];
export type Ipv6Address = [number, number, number, number, number, number, number, number];

export type IpSocketAddress =
  | { tag: 'ipv4'; val: { port: number; address: Ipv4Address } }
  | {
      tag: 'ipv6';
      val: { port: number; address: Ipv6Address; flowInfo: number; scopeId: number };
    };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIPv4(host: string): boolean {
  return parseIpv4(host) !== undefined;
}

export function isIPv6(host: string): boolean {
  return parseIpv6(stripIpv6Brackets(host)) !== undefined;
}

export function isIP(host: string): 0 | 4 | 6 {
  if (isIPv4(host)) return 4;
  if (isIPv6(host)) return 6;
  return 0;
}

export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function parseIpv4(host: string): Ipv4Address | undefined {
  const match = IPV4.exec(host);
  if (match === null) return undefined;
  const parts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const value = Number(match[i]);
    if (!Number.isInteger(value) || value > 255) return undefined;
    parts.push(value);
  }
  return parts as Ipv4Address;
}

export function parseIpv6(host: string): Ipv6Address | undefined {
  const input = stripIpv6Brackets(host);
  if (input.includes('.')) return undefined;
  const halves = input.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === '') return [];
    const values: number[] = [];
    for (const token of part.split(':')) {
      if (token === '') return undefined;
      if (!/^[0-9A-Fa-f]{1,4}$/.test(token)) return undefined;
      const value = Number.parseInt(token, 16);
      if (Number.isNaN(value) || value > 0xffff) return undefined;
      values.push(value);
    }
    return values;
  };
  if (halves.length === 1) {
    const parts = parse(halves[0]);
    if (parts === undefined || parts.length !== 8) return undefined;
    return parts as Ipv6Address;
  }
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  if (left === undefined || right === undefined) return undefined;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return undefined;
  return [...left, ...Array<number>(fill).fill(0), ...right] as Ipv6Address;
}

export function formatIpv4(address: Ipv4Address): string {
  return address.join('.');
}

export function formatIpv6(address: Ipv6Address): string {
  return address.map((part) => part.toString(16)).join(':');
}

function tuple4(value: unknown): Ipv4Address | undefined {
  const parts = Array.isArray(value) ? value : undefined;
  if (parts === undefined || parts.length !== 4) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return numbers as Ipv4Address;
}

function tuple8(value: unknown): Ipv6Address | undefined {
  const parts = Array.isArray(value) ? value : undefined;
  if (parts === undefined || parts.length !== 8) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return undefined;
  }
  return numbers as Ipv6Address;
}

export function parseIpSocketAddress(value: unknown): IpSocketAddress | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const tagged = value as { tag?: unknown; val?: unknown };
  if (tagged.tag === 'ipv4') {
    const record = tagged.val as { port?: unknown; address?: unknown } | undefined;
    const address = tuple4(record?.address);
    const port = Number(record?.port);
    if (address === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
      return undefined;
    }
    return { tag: 'ipv4', val: { port, address } };
  }
  if (tagged.tag === 'ipv6') {
    const record = tagged.val as {
      port?: unknown;
      address?: unknown;
      flowInfo?: unknown;
      'flow-info'?: unknown;
      scopeId?: unknown;
      'scope-id'?: unknown;
    };
    const address = tuple8(record?.address);
    const port = Number(record?.port);
    if (address === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
      return undefined;
    }
    return {
      tag: 'ipv6',
      val: {
        port,
        address,
        flowInfo: Number(record?.flowInfo ?? record?.['flow-info'] ?? 0),
        scopeId: Number(record?.scopeId ?? record?.['scope-id'] ?? 0),
      },
    };
  }
  return undefined;
}

export function formatIpSocketAddress(address: IpSocketAddress): {
  address: string;
  family: 'IPv4' | 'IPv6';
  port: number;
} {
  if (address.tag === 'ipv4') {
    return { address: formatIpv4(address.val.address), family: 'IPv4', port: address.val.port };
  }
  return { address: formatIpv6(address.val.address), family: 'IPv6', port: address.val.port };
}

export function ipSocketAddress(
  host: string,
  port: number,
  family: IpAddressFamily = 'ipv4',
): IpSocketAddress | undefined {
  const hostname = host === '' ? (family === 'ipv6' ? '::' : '0.0.0.0') : host;
  if (hostname === 'localhost' || hostname === 'localhost.') {
    return family === 'ipv6'
      ? {
          tag: 'ipv6',
          val: { port, address: [0, 0, 0, 0, 0, 0, 0, 1], flowInfo: 0, scopeId: 0 },
        }
      : { tag: 'ipv4', val: { port, address: [127, 0, 0, 1] } };
  }
  const v4 = parseIpv4(hostname);
  if (v4 !== undefined) return { tag: 'ipv4', val: { port, address: v4 } };
  const v6 = parseIpv6(hostname);
  if (v6 !== undefined) {
    return { tag: 'ipv6', val: { port, address: v6, flowInfo: 0, scopeId: 0 } };
  }
  return undefined;
}

export function unspecifiedAddress(family: IpAddressFamily, port: number): IpSocketAddress {
  return family === 'ipv6'
    ? { tag: 'ipv6', val: { port, address: [0, 0, 0, 0, 0, 0, 0, 0], flowInfo: 0, scopeId: 0 } }
    : { tag: 'ipv4', val: { port, address: [0, 0, 0, 0] } };
}

export function familyFromHost(host: string, fallback: IpAddressFamily = 'ipv4'): IpAddressFamily {
  if (isIPv6(host) || (host === 'localhost' && fallback === 'ipv6')) return 'ipv6';
  if (isIPv4(host) || host === 'localhost') return 'ipv4';
  return fallback;
}
