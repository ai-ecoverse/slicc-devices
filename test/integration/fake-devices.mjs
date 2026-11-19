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

export class FakeUSBDevice extends EventTarget {
  constructor(
    info = {},
    {
      configuration = null,
      configurations = null,
      opens = null,
      gate = null,
      protected: blocked = null,
      inData = null,
      controlIn = null,
      inStatus = null,
      outStatus = null,
      controlInStatus = null,
      controlOutStatus = null,
    } = {}
  ) {
    super();
    this.vendorId = info.vendorId ?? 0;
    this.productId = info.productId ?? 0;
    this.deviceClass = info.deviceClass ?? 0;
    this.productName = info.productName;
    this.manufacturerName = info.manufacturerName;
    this.serialNumber = info.serialNumber;
    this.opened = false;
    this.configuration = configuration;
    this.configurations = configurations ?? (configuration ? [configuration] : []);
    this.opens = opens;
    this.gate = gate;
    this.blocked = blocked;
    this.inData = inData;
    this.controlIn = controlIn;
    this.inStatus = inStatus;
    this.outStatus = outStatus;
    this.controlInStatus = controlInStatus;
    this.controlOutStatus = controlOutStatus;
    this.claimed = new Set();
    this.halts = new Set();
    this.written = [];
    this.controls = [];
    this.calls = [];
    this.usb = null;
  }

  async open() {
    this.calls.push(['open']);
    if (this.opens) throw new DOMException(this.opens.message, this.opens.name);
    if (this.opened) throw new DOMException('The device is already open.', 'InvalidStateError');
    if (this.gate) await this.gate;
    this.opened = true;
  }

  async close() {
    this.calls.push(['close']);
    if (!this.opened) throw new DOMException('The device is already closed.', 'InvalidStateError');
    this.claimed.clear();
    for (const iface of this.configuration?.interfaces ?? []) iface.claimed = false;
    this.opened = false;
    this.configuration = this.configurations[0] ?? null;
  }

  async selectConfiguration(value) {
    this.calls.push(['selectConfiguration', value]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    const found = this.configurations.find((c) => c.configurationValue === value);
    if (!found) throw new DOMException('The configuration value is invalid.', 'NotFoundError');
    this.configuration = found;
  }

  async claimInterface(number) {
    this.calls.push(['claimInterface', number]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.blocked?.has?.(number))
      throw new DOMException('The interface class is protected.', 'SecurityError');
    if (this.claimed.has(number))
      throw new DOMException('The interface is already claimed.', 'InvalidStateError');
    this.claimed.add(number);
    const iface = this.configuration?.interfaces?.find((i) => i.interfaceNumber === number);
    if (iface) iface.claimed = true;
  }

  async releaseInterface(number) {
    this.calls.push(['releaseInterface', number]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (!this.claimed.has(number))
      throw new DOMException('The interface is not claimed.', 'InvalidStateError');
    this.claimed.delete(number);
    const iface = this.configuration?.interfaces?.find((i) => i.interfaceNumber === number);
    if (iface) iface.claimed = false;
  }

  async controlTransferIn(setup, length) {
    this.calls.push(['controlTransferIn', setup, length]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    this.controls.push({ setup, length, direction: 'in' });
    const status =
      typeof this.controlInStatus === 'function'
        ? await this.controlInStatus(setup, length)
        : (this.controlInStatus ?? 'ok');
    if (status !== 'ok') return { status, data: undefined };
    const source =
      typeof this.controlIn === 'function' ? await this.controlIn(setup, length) : this.controlIn;
    if (this.dead || !this.opened) throw lost();
    const bytes = source ?? new Uint8Array(length).fill(0xab);
    const data = bytes.byteLength > length ? bytes.subarray(0, length) : bytes;
    return {
      status: 'ok',
      data: { buffer: data.buffer, byteOffset: data.byteOffset, byteLength: data.byteLength },
    };
  }

  async controlTransferOut(setup, data) {
    this.calls.push(['controlTransferOut', setup, data]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    const bytes = data ? new Uint8Array(data) : new Uint8Array(0);
    this.controls.push({ setup, bytes, direction: 'out' });
    const status =
      typeof this.controlOutStatus === 'function'
        ? await this.controlOutStatus(setup, bytes)
        : (this.controlOutStatus ?? 'ok');
    return { status, bytesWritten: status === 'ok' ? bytes.byteLength : 0 };
  }

  async transferIn(endpoint, length) {
    this.calls.push(['transferIn', endpoint, length]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    if (this.halts.has(`in:${endpoint}`))
      throw new DOMException('The transfer failed.', 'NetworkError');
    const status =
      typeof this.inStatus === 'function'
        ? await this.inStatus(endpoint, length)
        : (this.inStatus ?? 'ok');
    if (status !== 'ok') return { status, data: undefined };
    const source =
      typeof this.inData === 'function' ? await this.inData(endpoint, length) : this.inData;
    if (this.dead) throw lost();
    const bytes = source ?? new Uint8Array(length).fill(0xcd);
    const data = bytes.byteLength > length ? bytes.subarray(0, length) : bytes;
    return {
      status: 'ok',
      data: { buffer: data.buffer, byteOffset: data.byteOffset, byteLength: data.byteLength },
    };
  }

  async transferOut(endpoint, data) {
    this.calls.push(['transferOut', endpoint, data]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    if (this.halts.has(`out:${endpoint}`))
      throw new DOMException('The transfer failed.', 'NetworkError');
    const bytes = new Uint8Array(data);
    this.written.push({ endpoint, bytes });
    const status =
      typeof this.outStatus === 'function'
        ? await this.outStatus(endpoint, bytes)
        : (this.outStatus ?? 'ok');
    return { status, bytesWritten: status === 'ok' ? bytes.byteLength : 0 };
  }

  async clearHalt(direction, endpoint) {
    this.calls.push(['clearHalt', direction, endpoint]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    this.halts.delete(`${direction}:${endpoint}`);
  }

  async reset() {
    this.calls.push(['reset']);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    this.claimed.clear();
    for (const iface of this.configuration?.interfaces ?? []) iface.claimed = false;
  }

  unplug() {
    this.dead = true;
    this.opened = false;
    this.usb?.unplug(this);
  }
}

export function usbConfig(value = 1, interfaces = [{ interfaceNumber: 0 }]) {
  return {
    configurationValue: value,
    interfaces: interfaces.map((iface) => {
      const alternates = iface.alternates ?? [
        {
          alternateSetting: 0,
          interfaceClass: iface.interfaceClass ?? 0xff,
          interfaceSubclass: iface.interfaceSubclass ?? 0,
          interfaceProtocol: iface.interfaceProtocol ?? 0,
          endpoints: iface.endpoints ?? [
            { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
            { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
          ],
        },
      ];
      const alternateSetting = iface.alternateSetting ?? 0;
      return {
        interfaceNumber: iface.interfaceNumber,
        claimed: false,
        alternateSetting,
        alternate:
          alternates.find((alt) => alt.alternateSetting === alternateSetting) ?? alternates[0],
        alternates,
      };
    }),
  };
}

export class FakeUSB extends EventTarget {
  constructor({ devices = [], choose = () => undefined, activation = null } = {}) {
    super();
    this.devices = devices.map((device) => this.own(device));
    this.choose = choose;
    this.activation = activation;
    this.calls = [];
  }

  own(device) {
    const owned = device instanceof FakeUSBDevice ? device : new FakeUSBDevice(device);
    owned.usb = this;
    if (!owned.configuration && !owned.configurations.length) {
      owned.configuration = usbConfig();
      owned.configurations = [owned.configuration];
    }
    return owned;
  }

  async getDevices() {
    this.calls.push(['getDevices']);
    return [...this.devices];
  }

  async requestDevice(options = {}) {
    const active = this.activation ? this.activation() : undefined;
    this.calls.push(
      active === undefined ? ['requestDevice', options] : ['requestDevice', options, active]
    );
    if (active === false)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    const device = await this.choose(options, this);
    if (!device) throw new DOMException('No device selected by the user.', 'NotFoundError');
    const owned = this.own(device);
    if (!this.devices.includes(owned)) this.devices.push(owned);
    return owned;
  }

  plug(device) {
    const owned = this.own(device);
    this.devices.push(owned);
    const fired = new Event('connect');
    Object.defineProperty(fired, 'device', { value: owned });
    this.dispatchEvent(fired);
    return owned;
  }

  unplug(device) {
    this.devices = this.devices.filter((other) => other !== device);
    const fired = new Event('disconnect');
    Object.defineProperty(fired, 'device', { value: device });
    this.dispatchEvent(fired);
  }
}

export class FakeHIDDevice extends EventTarget {
  constructor(
    info = {},
    {
      collections = null,
      opens = null,
      gate = null,
      feature = null,
      protected: blocked = null,
    } = {}
  ) {
    super();
    this.vendorId = info.vendorId ?? 0;
    this.productId = info.productId ?? 0;
    this.productName = info.productName ?? '';
    this.opened = false;
    this.collections = collections ?? info.collections ?? [{ usagePage: 0xff60, usage: 0x61 }];
    this.opens = opens;
    this.gate = gate;
    this.feature = feature;
    this.blocked = blocked;
    this.sent = [];
    this.features = [];
    this.calls = [];
    this.hid = null;
    this.opening = false;
  }

  async open() {
    this.calls.push(['open']);
    if (this.blocked)
      throw new DOMException(
        this.blocked.message ?? 'A device with protected usages was requested.',
        this.blocked.name ?? 'NotAllowedError'
      );
    if (this.opens) throw new DOMException(this.opens.message, this.opens.name);
    if (this.opened || this.opening)
      throw new DOMException('The device is already open.', 'InvalidStateError');
    this.opening = true;
    try {
      if (this.gate) await this.gate;
      this.opened = true;
    } finally {
      this.opening = false;
    }
  }

  async close() {
    this.calls.push(['close']);
    if (!this.opened) throw new DOMException('The device is already closed.', 'InvalidStateError');
    this.opened = false;
  }

  async sendReport(reportId, data) {
    this.calls.push(['sendReport', reportId, data]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    const bytes = new Uint8Array(data);
    this.sent.push({ reportId, bytes });
  }

  async sendFeatureReport(reportId, data) {
    this.calls.push(['sendFeatureReport', reportId, data]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    const bytes = new Uint8Array(data);
    this.features.push({ reportId, bytes, direction: 'out' });
  }

  async receiveFeatureReport(reportId) {
    this.calls.push(['receiveFeatureReport', reportId]);
    if (!this.opened) throw new DOMException('The device is not open.', 'InvalidStateError');
    if (this.dead) throw lost();
    const source = typeof this.feature === 'function' ? await this.feature(reportId) : this.feature;
    if (this.dead || !this.opened) throw lost();
    const bytes = source ?? new Uint8Array([0xaa, 0xbb]);
    this.features.push({ reportId, bytes, direction: 'in' });
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  input(reportId, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fired = new Event('inputreport');
    Object.defineProperty(fired, 'reportId', { value: reportId });
    Object.defineProperty(fired, 'data', { value: view });
    Object.defineProperty(fired, 'device', { value: this });
    this.dispatchEvent(fired);
  }

  unplug() {
    this.dead = true;
    this.opened = false;
    this.hid?.unplug(this);
  }
}

export class FakeHID extends EventTarget {
  constructor({ devices = [], choose = () => undefined, activation = null } = {}) {
    super();
    this.devices = devices.map((device) => this.own(device));
    this.choose = choose;
    this.activation = activation;
    this.calls = [];
  }

  own(device) {
    const owned = device instanceof FakeHIDDevice ? device : new FakeHIDDevice(device);
    owned.hid = this;
    return owned;
  }

  async getDevices() {
    this.calls.push(['getDevices']);
    return [...this.devices];
  }

  async requestDevice(options = {}) {
    const active = this.activation ? this.activation() : undefined;
    this.calls.push(
      active === undefined ? ['requestDevice', options] : ['requestDevice', options, active]
    );
    if (active === false)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    const chosen = await this.choose(options, this);
    const list = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    if (list.length === 0)
      throw new DOMException('No device selected by the user.', 'NotFoundError');
    const owned = list.map((device) => this.own(device));
    for (const device of owned) {
      if (!this.devices.includes(device)) this.devices.push(device);
    }
    return owned;
  }

  plug(device) {
    const owned = this.own(device);
    this.devices.push(owned);
    const fired = new Event('connect');
    Object.defineProperty(fired, 'device', { value: owned });
    this.dispatchEvent(fired);
    return owned;
  }

  unplug(device) {
    this.devices = this.devices.filter((other) => other !== device);
    const fired = new Event('disconnect');
    Object.defineProperty(fired, 'device', { value: device });
    this.dispatchEvent(fired);
  }
}

export function install(target, fakes = {}) {
  const installed = {
    serial: new FakeSerial(),
    usb: new FakeUSB(),
    hid: new FakeHID(),
    ...fakes,
  };
  for (const [name, value] of Object.entries(installed)) {
    Object.defineProperty(target, name, { value, configurable: true });
  }
  return installed;
}

export function errno(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'EACCES';
  if (error?.name === 'NotSupportedError') return 'ENOTSUP';
  if (error?.name === 'NotFoundError') return 'ENOENT';
  if (error?.name === 'NoModificationAllowedError') return 'EBUSY';
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
