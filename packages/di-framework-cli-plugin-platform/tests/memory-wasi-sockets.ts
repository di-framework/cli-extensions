import {
  formatIpSocketAddress,
  type IpAddressFamily,
  type IpSocketAddress,
  parseIpv4,
  parseIpv6,
} from '../src/node-compat/socket-address';

type Waiter<T> = (value: T | undefined) => void;

class AsyncQueue<T> {
  items: T[] = [];
  waiters: Array<Waiter<T>> = [];
  ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        const next = this.items.shift();
        if (next !== undefined) yield next;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<T | undefined>((resolve) => this.waiters.push(resolve));
      if (next === undefined) return;
      yield next;
    }
  }
}

type TcpBind = {
  socket: MemoryTcpSocket;
  address: IpSocketAddress;
  accept: AsyncQueue<MemoryTcpSocket>;
};

type UdpBind = {
  socket: MemoryUdpSocket;
  address: IpSocketAddress;
  datagrams: AsyncQueue<[Uint8Array, IpSocketAddress]>;
};

const tcpBinds = new Map<string, TcpBind>();
const udpBinds = new Map<string, UdpBind>();
let nextPort = 49152;

export const nameRecords = new Map<string, unknown[]>();

export function resetMemorySockets(): void {
  tcpBinds.clear();
  udpBinds.clear();
  nameRecords.clear();
  nextPort = 49152;
}

function bindKey(kind: 'tcp' | 'udp', address: IpSocketAddress): string {
  const formatted = formatIpSocketAddress(address);
  return `${kind}:${formatted.family}:${formatted.address}:${formatted.port}`;
}

function assignPort(address: IpSocketAddress): IpSocketAddress {
  if (address.tag === 'ipv4') {
    const port = address.val.port === 0 ? nextPort++ : address.val.port;
    return { tag: 'ipv4', val: { port, address: address.val.address } };
  }
  const port = address.val.port === 0 ? nextPort++ : address.val.port;
  return {
    tag: 'ipv6',
    val: {
      port,
      address: address.val.address,
      flowInfo: address.val.flowInfo,
      scopeId: address.val.scopeId,
    },
  };
}

function isUnspecified(address: IpSocketAddress): boolean {
  if (address.tag === 'ipv4') return address.val.address.every((part) => part === 0);
  return address.val.address.every((part) => part === 0);
}

function rewriteConnectTarget(address: IpSocketAddress): IpSocketAddress {
  if (address.tag === 'ipv4' && isUnspecified(address)) {
    return { tag: 'ipv4', val: { port: address.val.port, address: [127, 0, 0, 1] } };
  }
  if (address.tag === 'ipv6' && isUnspecified(address)) {
    return {
      tag: 'ipv6',
      val: {
        port: address.val.port,
        address: [0, 0, 0, 0, 0, 0, 0, 1],
        flowInfo: 0,
        scopeId: 0,
      },
    };
  }
  return address;
}

function findTcpListener(remote: IpSocketAddress): TcpBind | undefined {
  const exact = tcpBinds.get(bindKey('tcp', remote));
  if (exact !== undefined) return exact;
  const formatted = formatIpSocketAddress(remote);
  const unspecified =
    remote.tag === 'ipv6'
      ? bindKey('tcp', {
          tag: 'ipv6',
          val: {
            port: formatted.port,
            address: [0, 0, 0, 0, 0, 0, 0, 0],
            flowInfo: 0,
            scopeId: 0,
          },
        })
      : bindKey('tcp', { tag: 'ipv4', val: { port: formatted.port, address: [0, 0, 0, 0] } });
  return tcpBinds.get(unspecified);
}

function findUdpReceiver(remote: IpSocketAddress): UdpBind | undefined {
  const exact = udpBinds.get(bindKey('udp', remote));
  if (exact !== undefined) return exact;
  const formatted = formatIpSocketAddress(remote);
  const unspecified =
    remote.tag === 'ipv6'
      ? bindKey('udp', {
          tag: 'ipv6',
          val: {
            port: formatted.port,
            address: [0, 0, 0, 0, 0, 0, 0, 0],
            flowInfo: 0,
            scopeId: 0,
          },
        })
      : bindKey('udp', { tag: 'ipv4', val: { port: formatted.port, address: [0, 0, 0, 0] } });
  return udpBinds.get(unspecified);
}

function ok<T>(val: T): { tag: 'ok'; val: T } {
  return { tag: 'ok', val };
}

function err(code: string): { tag: 'err'; val: string } {
  return { tag: 'err', val: code };
}

export class MemoryTcpSocket {
  family: IpAddressFamily;
  local: IpSocketAddress | undefined;
  remote: IpSocketAddress | undefined;
  incoming = new AsyncQueue<Uint8Array>();
  peer: MemoryTcpSocket | undefined;
  sending = false;
  listening = false;

  constructor(family: IpAddressFamily) {
    this.family = family;
  }

  static create(family: IpAddressFamily): { tag: 'ok'; val: MemoryTcpSocket } {
    return ok(new MemoryTcpSocket(family));
  }

  bind(localAddress: IpSocketAddress): { tag: 'ok'; val: undefined } | { tag: 'err'; val: string } {
    const assigned = assignPort(localAddress);
    const key = bindKey('tcp', assigned);
    if (tcpBinds.has(key)) return err('address-in-use');
    this.local = assigned;
    tcpBinds.set(key, { socket: this, address: assigned, accept: new AsyncQueue() });
    return ok(undefined);
  }

  listen(): { tag: 'ok'; val: AsyncQueue<MemoryTcpSocket> } | { tag: 'err'; val: string } {
    if (this.local === undefined) return err('invalid-state');
    const bound = tcpBinds.get(bindKey('tcp', this.local));
    if (bound === undefined) return err('invalid-state');
    this.listening = true;
    return ok(bound.accept);
  }

  async connect(
    remoteAddress: IpSocketAddress,
  ): Promise<{ tag: 'ok'; val: undefined } | { tag: 'err'; val: string }> {
    const target = rewriteConnectTarget(remoteAddress);
    const listener = findTcpListener(target);
    if (listener === undefined) return err('connection-refused');
    if (this.local === undefined) {
      const family: IpAddressFamily = target.tag === 'ipv6' ? 'ipv6' : 'ipv4';
      const local =
        family === 'ipv6'
          ? ({
              tag: 'ipv6',
              val: {
                port: 0,
                address: [0, 0, 0, 0, 0, 0, 0, 1],
                flowInfo: 0,
                scopeId: 0,
              },
            } satisfies IpSocketAddress)
          : ({ tag: 'ipv4', val: { port: 0, address: [127, 0, 0, 1] } } satisfies IpSocketAddress);
      this.bind(local);
    }
    const accepted = new MemoryTcpSocket(this.family);
    accepted.local = listener.address;
    accepted.remote = this.local;
    this.remote = target;
    this.peer = accepted;
    accepted.peer = this;
    listener.accept.push(accepted);
    return ok(undefined);
  }

  send(
    data: AsyncIterable<Uint8Array>,
  ): Promise<{ tag: 'ok'; val: undefined } | { tag: 'err'; val: string }> {
    if (this.sending) return Promise.resolve(err('invalid-state'));
    this.sending = true;
    const peer = this.peer;
    if (peer === undefined) return Promise.resolve(err('invalid-state'));
    return (async () => {
      for await (const chunk of data) peer.incoming.push(chunk);
      peer.incoming.end();
      return ok(undefined);
    })();
  }

  receive(): [AsyncQueue<Uint8Array>, Promise<{ tag: 'ok'; val: undefined }>] {
    return [this.incoming, Promise.resolve(ok(undefined))];
  }

  getLocalAddress(): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: string } {
    return this.local === undefined ? err('invalid-state') : ok(this.local);
  }

  getRemoteAddress(): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: string } {
    return this.remote === undefined ? err('invalid-state') : ok(this.remote);
  }
}

export class MemoryUdpSocket {
  family: IpAddressFamily;
  local: IpSocketAddress | undefined;
  datagrams = new AsyncQueue<[Uint8Array, IpSocketAddress]>();

  constructor(family: IpAddressFamily) {
    this.family = family;
  }

  static create(family: IpAddressFamily): { tag: 'ok'; val: MemoryUdpSocket } {
    return ok(new MemoryUdpSocket(family));
  }

  bind(localAddress: IpSocketAddress): { tag: 'ok'; val: undefined } | { tag: 'err'; val: string } {
    const assigned = assignPort(localAddress);
    const key = bindKey('udp', assigned);
    if (udpBinds.has(key)) return err('address-in-use');
    this.local = assigned;
    udpBinds.set(key, { socket: this, address: assigned, datagrams: this.datagrams });
    return ok(undefined);
  }

  async send(
    data: Uint8Array | number[],
    remoteAddress?: IpSocketAddress,
  ): Promise<{ tag: 'ok'; val: undefined } | { tag: 'err'; val: string }> {
    if (remoteAddress === undefined) return err('invalid-argument');
    if (this.local === undefined)
      this.bind(
        assignPort(
          remoteAddress.tag === 'ipv6'
            ? {
                tag: 'ipv6',
                val: { port: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], flowInfo: 0, scopeId: 0 },
              }
            : { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } },
        ),
      );
    const receiver = findUdpReceiver(remoteAddress);
    const payload = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const from = this.local;
    if (receiver !== undefined && from !== undefined) receiver.datagrams.push([payload, from]);
    return ok(undefined);
  }

  async receive(): Promise<
    { tag: 'ok'; val: [Uint8Array, IpSocketAddress] } | { tag: 'err'; val: string }
  > {
    for await (const datagram of this.datagrams) return ok(datagram);
    return err('connection-aborted');
  }

  getLocalAddress(): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: string } {
    return this.local === undefined ? err('invalid-state') : ok(this.local);
  }

  getRemoteAddress(): { tag: 'err'; val: string } {
    return err('invalid-state');
  }
}

export const TcpSocket = MemoryTcpSocket;
export const UdpSocket = MemoryUdpSocket;

export async function resolveAddresses(
  name: string,
): Promise<{ tag: 'ok'; val: unknown[] } | { tag: 'err'; val: string }> {
  const recorded = nameRecords.get(name);
  if (recorded !== undefined) return ok(recorded);
  const v4 = parseIpv4(name);
  if (v4 !== undefined) return ok([{ tag: 'ipv4', val: v4 }]);
  const v6 = parseIpv6(name);
  if (v6 !== undefined) return ok([{ tag: 'ipv6', val: v6 }]);
  if (name === 'localhost') return ok([{ tag: 'ipv4', val: [127, 0, 0, 1] }]);
  return err('name-unresolvable');
}
