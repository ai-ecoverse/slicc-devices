const lost = () => new DOMException('The device has been lost.', 'NetworkError');

export class FakeSerialPort extends EventTarget {
  constructor(
    info = {},
    { echo = false, sink = 0, opens = null, gate = null, boot = null, device = null } = {}
  ) {
    super();
    this.info = { ...info };
    this.readable = null;
    this.writable = null;
    this.echo = echo;
    this.sink = sink;
    this.opens = opens;
    this.gate = gate;
    this.boot = boot;
    this.device = device?.attach(this) ?? null;
    this.written = [];
    this.submitted = 0;
    this.ahead = 0;
    this.writtenBytes = 0;
    this.outputs = [];
    this.inputs = {
      clearToSend: true,
      dataCarrierDetect: false,
      dataSetReady: true,
      ringIndicator: false,
    };
    this.options = null;
    this.serial = null;
    this.feeder = null;
    this.calls = [];
  }

  getInfo() {
    return { ...this.info };
  }

  async open(options) {
    this.calls.push(['open', options]);
    if (this.opens) throw new DOMException(this.opens.message, this.opens.name);
    if (this.readable || this.writable)
      throw new DOMException('The port is already open.', 'InvalidStateError');
    if (this.gate) await this.gate;
    this.options = options;
    this.readable = new ReadableStream({
      start: (controller) => {
        this.feeder = controller;
      },
      cancel: () => {
        this.feeder = null;
      },
    });
    this.writable = new WritableStream(
      {
        write: async (chunk) => {
          if (this.dead) throw lost();
          if (this.sink) await new Promise((resolve) => setTimeout(resolve, this.sink));
          const bytes = new Uint8Array(chunk);
          this.written.push(bytes);
          this.writtenBytes += bytes.byteLength;
          if (this.echo) this.feed(bytes);
          this.device?.receive(bytes);
        },
      },
      { highWaterMark: 1 }
    );
    const writer = this.writable.getWriter.bind(this.writable);
    this.writable.getWriter = () => {
      const got = writer();
      const write = got.write.bind(got);
      got.write = (chunk) => {
        this.submitted += 1;
        this.ahead = Math.max(this.ahead, this.submitted - this.written.length);
        return write(chunk);
      };
      return got;
    };
    if (this.boot != null) this.feed(this.boot);
  }

  feed(bytes) {
    const data =
      typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
    this.feeder?.enqueue(data);
  }

  text() {
    return new TextDecoder().decode(
      this.written.reduce((all, part) => {
        const out = new Uint8Array(all.length + part.length);
        out.set(all);
        out.set(part, all.length);
        return out;
      }, new Uint8Array(0))
    );
  }

  async close() {
    this.calls.push(['close']);
    if (!this.readable && !this.writable)
      throw new DOMException('The port is already closed.', 'InvalidStateError');
    if (this.readable?.locked || this.writable?.locked)
      throw new DOMException('Cannot close a port with a locked stream.', 'InvalidStateError');
    try {
      await this.readable?.cancel();
    } catch {}
    try {
      await this.writable?.abort();
    } catch {}
    this.readable = null;
    this.writable = null;
    this.feeder = null;
    this.options = null;
  }

  async getSignals() {
    if (!this.readable) throw new DOMException('The port is closed.', 'InvalidStateError');
    return { ...this.inputs };
  }

  async setSignals(signals) {
    if (!this.readable) throw new DOMException('The port is closed.', 'InvalidStateError');
    this.outputs.push({ ...signals });
    this.device?.signal(signals);
  }

  unplug() {
    this.dead = true;
    try {
      this.feeder?.error(lost());
    } catch {}
    try {
      if (this.writable && !this.writable.locked) this.writable.abort(lost());
    } catch {}
    this.readable = null;
    this.writable = null;
    this.feeder = null;
    this.serial?.unplug(this);
  }
}

function event(type, target) {
  const fired = new Event(type);
  Object.defineProperty(fired, 'target', { value: target });
  return fired;
}

export class FakeSerial extends EventTarget {
  constructor({ ports = [], choose = () => undefined, activation = null } = {}) {
    super();
    this.ports = ports.map((port) => this.own(port));
    this.choose = choose;
    this.activation = activation;
    this.calls = [];
  }

  own(port) {
    const owned = port instanceof FakeSerialPort ? port : new FakeSerialPort(port);
    owned.serial = this;
    return owned;
  }

  async getPorts() {
    this.calls.push(['getPorts']);
    return [...this.ports];
  }

  async requestPort(options = {}) {
    const active = this.activation ? this.activation() : undefined;
    this.calls.push(
      active === undefined ? ['requestPort', options] : ['requestPort', options, active]
    );
    if (active === false)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    const port = await this.choose(options, this);
    if (!port) throw new DOMException('No port selected by the user.', 'NotFoundError');
    const owned = this.own(port);
    if (!this.ports.includes(owned)) this.ports.push(owned);
    return owned;
  }

  plug(port) {
    const owned = this.own(port);
    this.ports.push(owned);
    this.dispatchEvent(event('connect', owned));
    return owned;
  }

  unplug(port) {
    this.ports = this.ports.filter((other) => other !== port);
    this.dispatchEvent(event('disconnect', port));
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

function counted(body, tally) {
  if (!body?.getReader) return body;
  const reader = body.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) return controller.close();
        tally.push(value.byteLength);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 }
  );
}

export function embedder(page, extra = {}, { gesture = async () => true } = {}) {
  const current = typeof page === 'function' ? page : () => page;
  const requests = [];
  const prompts = [];
  const body = [];
  return {
    requests,
    prompts,
    body,
    kinds: { ...current().kinds, ...extra },
    async handle(request) {
      const answering = current();
      requests.push({ kind: request.kind, options: request.options, stamp: request.stamp });
      const asking = answering.prompts?.[request.kind];
      const prompt = asking ? await asking(request) : null;
      if (prompt) {
        prompts.push(prompt);
        if (!(await gesture(prompt, request)))
          throw new DOMException(prompt.dismissed, 'NotAllowedError');
      }
      return answering.handle({ ...request, body: counted(request.body, body) });
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

export function bytes(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text);
      controller.close();
    },
  });
}

export async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export async function drain(reply) {
  if (typeof reply === 'string') return reply;
  if (!reply) return '';
  return new TextDecoder().decode(await collect(reply));
}
