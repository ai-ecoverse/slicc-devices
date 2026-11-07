export class FakeSerialPort extends EventTarget {
  constructor(info = {}) {
    super();
    this.info = { ...info };
    this.readable = null;
    this.writable = null;
  }

  getInfo() {
    return { ...this.info };
  }
}

export class FakeSerial extends EventTarget {
  constructor({ ports = [], choose = () => undefined } = {}) {
    super();
    this.ports = ports.map((port) =>
      port instanceof FakeSerialPort ? port : new FakeSerialPort(port)
    );
    this.choose = choose;
    this.calls = [];
  }

  async getPorts() {
    this.calls.push(['getPorts']);
    return [...this.ports];
  }

  async requestPort(options = {}) {
    this.calls.push(['requestPort', options]);
    const port = await this.choose(options, this);
    if (!port) throw new DOMException('No port selected by the user.', 'NotFoundError');
    if (!this.ports.includes(port)) this.ports.push(port);
    return port;
  }
}

export function install(target, fakes = {}) {
  const installed = { serial: new FakeSerial(), ...fakes };
  for (const [name, value] of Object.entries(installed)) {
    Object.defineProperty(target, name, { value, configurable: true });
  }
  return installed;
}

export function errno(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'EACCES';
  if (error?.name === 'NotSupportedError') return 'ENOTSUP';
  if (error?.name === 'NotFoundError') return 'ENOENT';
  return 'EIO';
}

export function embedder(page, extra = {}) {
  const requests = [];
  return {
    requests,
    kinds: { ...page.kinds, ...extra },
    handle(request) {
      requests.push({ kind: request.kind, options: request.options, stamp: request.stamp });
      return page.handle(request);
    },
  };
}

export function request(kind, options = {}, fields = {}) {
  return {
    kind,
    options,
    body: new ReadableStream({ start: (controller) => controller.close() }),
    stamp: { pid: 1, uid: 0, gid: 0, groups: [0], users: 'enforce', kind },
    signal: new AbortController().signal,
    progress: () => {},
    ...fields,
  };
}
