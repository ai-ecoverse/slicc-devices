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
      onOpen = null,
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
    this.onOpen = onOpen;
    this.feature = feature;
    this.blocked = blocked;
    this.sent = [];
    this.features = [];
    this.calls = [];
    this.hid = null;
    this.opening = false;
    this.reports = new Set();
  }

  get listening() {
    return this.reports.size > 0;
  }

  addEventListener(type, listener, options) {
    if (type === 'inputreport') this.reports.add(listener);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === 'inputreport') this.reports.delete(listener);
    super.removeEventListener(type, listener, options);
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
      this.onOpen?.();
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

const BLE_BASE = '00000000-0000-1000-8000-00805f9b34fb';
const bleShort = (n) =>
  `${BLE_BASE.slice(0, 4)}${Number(n).toString(16).padStart(4, '0')}${BLE_BASE.slice(8)}`.toLowerCase();

function bleUuid(value) {
  if (typeof value === 'number') return bleShort(value);
  if (typeof value !== 'string') return String(value).toLowerCase();
  const trimmed = value.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed))
    return trimmed.toLowerCase();
  if (/^0x[0-9a-f]+$/i.test(trimmed) || /^[0-9a-f]+$/i.test(trimmed))
    return bleShort(Number.parseInt(trimmed.replace(/^0x/i, ''), 16));
  const aliases = {
    heart_rate: 0x180d,
    battery_service: 0x180f,
    device_information: 0x180a,
    heart_rate_measurement: 0x2a37,
    body_sensor_location: 0x2a38,
    battery_level: 0x2a19,
    gatt_client_characteristic_configuration: 0x2902,
  };
  if (aliases[trimmed] !== undefined) return bleShort(aliases[trimmed]);
  return trimmed.toLowerCase();
}

export class FakeBluetoothDescriptor {
  constructor(uuid, value = new Uint8Array(0)) {
    this.uuid = bleUuid(uuid);
    this._value = value instanceof Uint8Array ? value : new Uint8Array(value);
  }

  async readValue() {
    return new DataView(this._value.buffer, this._value.byteOffset, this._value.byteLength);
  }
}

export class FakeBluetoothCharacteristic extends EventTarget {
  constructor(
    uuid,
    {
      properties = { read: true, write: true, notify: true },
      value = new Uint8Array([0]),
      descriptors = [],
      gate = null,
      onWrite = null,
      block = null,
    } = {}
  ) {
    super();
    this.uuid = bleUuid(uuid);
    this.properties = { ...properties };
    this._value = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.descriptors = descriptors.map((d) =>
      d instanceof FakeBluetoothDescriptor ? d : new FakeBluetoothDescriptor(d.uuid ?? d, d.value)
    );
    this.gate = gate;
    this.onWrite = onWrite;
    this.block = block;
    this.notifying = false;
    this.writes = [];
    this.calls = [];
    this.service = null;
    this.busy = false;
  }

  get value() {
    return new DataView(this._value.buffer, this._value.byteOffset, this._value.byteLength);
  }

  async getDescriptor(uuid) {
    const want = bleUuid(uuid);
    const found = this.descriptors.find((d) => d.uuid === want);
    if (!found) throw new DOMException('Descriptor not found.', 'NotFoundError');
    return found;
  }

  async getDescriptors() {
    return [...this.descriptors];
  }

  async readValue() {
    this.calls.push(['readValue']);
    if (this.block) throw new DOMException(this.block.message, this.block.name);
    if (this.busy) throw new DOMException('GATT operation already in progress.', 'NetworkError');
    if (this.gate) await this.gate;
    if (!this.service?.device?.gatt?.connected)
      throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    return this.value;
  }

  async writeValueWithResponse(data) {
    this.calls.push(['writeValueWithResponse', data]);
    return this.#write(data, false);
  }

  async writeValueWithoutResponse(data) {
    this.calls.push(['writeValueWithoutResponse', data]);
    return this.#write(data, true);
  }

  async #write(data, noResponse) {
    if (this.block) throw new DOMException(this.block.message, this.block.name);
    if (this.busy) throw new DOMException('GATT operation already in progress.', 'NetworkError');
    if (this.gate) await this.gate;
    if (!this.service?.device?.gatt?.connected)
      throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    const bytes = new Uint8Array(data);
    this._value = bytes;
    this.writes.push({ bytes, noResponse });
    this.onWrite?.(bytes, noResponse);
  }

  async startNotifications() {
    this.calls.push(['startNotifications']);
    if (this.block) throw new DOMException(this.block.message, this.block.name);
    if (this.gate) await this.gate;
    if (!this.service?.device?.gatt?.connected)
      throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    this.notifying = true;
  }

  async stopNotifications() {
    this.calls.push(['stopNotifications']);
    if (this.stopGate) await this.stopGate;
    this.notifying = false;
  }

  notify(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    this._value = bytes;
    if (!this.notifying) return;
    const fired = new Event('characteristicvaluechanged');
    Object.defineProperty(fired, 'target', { value: this });
    this.dispatchEvent(fired);
  }
}

export class FakeBluetoothService {
  constructor(uuid, characteristics = []) {
    this.uuid = bleUuid(uuid);
    this.characteristics = characteristics.map((c) =>
      c instanceof FakeBluetoothCharacteristic ? c : new FakeBluetoothCharacteristic(c.uuid ?? c, c)
    );
    this.device = null;
    for (const characteristic of this.characteristics) characteristic.service = this;
  }

  async getCharacteristic(uuid) {
    const want = bleUuid(uuid);
    const found = this.characteristics.find((c) => c.uuid === want);
    if (!found) throw new DOMException('Characteristic not found.', 'NotFoundError');
    return found;
  }

  async getCharacteristics() {
    return [...this.characteristics];
  }
}

export class FakeBluetoothRemoteGATTServer {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this.gate = null;
    this.onConnect = null;
    this.opens = null;
    this.connecting = false;
  }

  async connect() {
    this.device.calls.push(['gatt.connect']);
    if (this.opens) throw new DOMException(this.opens.message, this.opens.name);
    if (this.connected || this.connecting)
      throw new DOMException('GATT Server already connected.', 'NetworkError');
    this.connecting = true;
    try {
      this.onConnect?.();
      if (this.gate) await this.gate;
      if (this.device.dead)
        throw new DOMException('Bluetooth adapter not available.', 'NetworkError');
      this.connected = true;
      return this;
    } finally {
      this.connecting = false;
    }
  }

  disconnect() {
    this.device.calls.push(['gatt.disconnect']);
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }

  async getPrimaryService(uuid) {
    if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    const want = bleUuid(uuid);
    const allowed = this.device.allowed;
    if (allowed && !allowed.has(want))
      throw new DOMException(
        "Origin is not allowed to access any service. Tip: Add the service UUID to 'optionalServices' in requestDevice() options.",
        'SecurityError'
      );
    const found = this.device.services.find((s) => s.uuid === want);
    if (!found) throw new DOMException('Service not found.', 'NotFoundError');
    if (found.blocklisted) throw new DOMException('This service is blocklisted.', 'SecurityError');
    return found;
  }

  async getPrimaryServices() {
    if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    const allowed = this.device.allowed;
    return this.device.services.filter((s) => !allowed || allowed.has(s.uuid));
  }
}

export class FakeBluetoothDevice extends EventTarget {
  constructor(
    info = {},
    { services = null, allowed = null, gate = null, onConnect = null, opens = null, id = null } = {}
  ) {
    super();
    this.id = id ?? info.id ?? `device-${Math.random().toString(16).slice(2)}`;
    this.name = info.name ?? 'Polar H10';
    this.calls = [];
    this.dead = false;
    this.bluetooth = null;
    this.services = (services ?? info.services ?? defaultHeartRate()).map((s) =>
      s instanceof FakeBluetoothService
        ? s
        : new FakeBluetoothService(s.uuid ?? s, s.characteristics)
    );
    for (const service of this.services) service.device = this;
    this.allowed = allowed
      ? new Set([...allowed].map(bleUuid))
      : new Set(this.services.map((s) => s.uuid));
    this.gatt = new FakeBluetoothRemoteGATTServer(this);
    if (gate) this.gatt.gate = gate;
    if (onConnect) this.gatt.onConnect = onConnect;
    if (opens) this.gatt.opens = opens;
  }

  unplug() {
    this.dead = true;
    if (this.gatt.connected) this.gatt.disconnect();
    this.bluetooth?.forget(this);
  }
}

function defaultHeartRate() {
  return [
    new FakeBluetoothService('heart_rate', [
      new FakeBluetoothCharacteristic('heart_rate_measurement', {
        properties: { notify: true, read: true },
        value: new Uint8Array([0x06, 0x3c]),
      }),
      new FakeBluetoothCharacteristic('body_sensor_location', {
        properties: { read: true },
        value: new Uint8Array([1]),
      }),
    ]),
  ];
}

export class FakeBluetooth extends EventTarget {
  constructor({
    devices = [],
    choose = () => undefined,
    activation = null,
    getDevices = true,
  } = {}) {
    super();
    this.devices = devices.map((device) => this.own(device));
    this.choose = choose;
    this.activation = activation;
    this.calls = [];
    this.adapter = true;
    if (getDevices) {
      this.getDevices = async () => {
        this.calls.push(['getDevices']);
        return [...this.devices];
      };
    }
  }

  own(device) {
    const owned = device instanceof FakeBluetoothDevice ? device : new FakeBluetoothDevice(device);
    owned.bluetooth = this;
    return owned;
  }

  async requestDevice(options = {}) {
    const active = this.activation ? this.activation() : undefined;
    this.calls.push(
      active === undefined ? ['requestDevice', options] : ['requestDevice', options, active]
    );
    if (!this.adapter) throw new DOMException('Bluetooth adapter not available.', 'NetworkError');
    if (active === false)
      throw new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError'
      );
    const chosen = await this.choose(options, this);
    if (!chosen)
      throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
    const owned = this.own(chosen);
    const optional = new Set((options.optionalServices ?? []).map(bleUuid));
    for (const filter of options.filters ?? []) {
      for (const service of filter.services ?? []) optional.add(bleUuid(service));
    }
    if (optional.size) owned.allowed = optional;
    if (!this.devices.includes(owned)) this.devices.push(owned);
    return owned;
  }

  forget(device) {
    this.devices = this.devices.filter((other) => other !== device);
  }
}

export class FakeMIDIPort extends EventTarget {
  constructor(info = {}, { opens = null, gate = null, closeGate = null, onOpen = null } = {}) {
    super();
    this.id = info.id ?? `port-${Math.random().toString(36).slice(2, 8)}`;
    this.type = info.type ?? 'input';
    this.name = info.name ?? '';
    this.manufacturer = info.manufacturer ?? '';
    this.state = info.state ?? 'connected';
    this.connection = 'closed';
    this.opens = opens;
    this.gate = gate;
    this.closeGate = closeGate;
    this.onOpen = onOpen;
    this.opening = false;
    this.sent = [];
    this.scheduled = [];
    this.onmidimessage = null;
    this.midi = null;
    this.calls = [];
  }

  get listening() {
    return typeof this.onmidimessage === 'function';
  }

  async open() {
    this.calls.push(['open']);
    if (this.opens) throw new DOMException(this.opens.message, this.opens.name);
    if (this.connection === 'open' || this.opening)
      throw new DOMException('The port is already open.', 'InvalidStateError');
    this.opening = true;
    const closes = this.calls.filter(([name]) => name === 'close').length;
    try {
      this.onOpen?.();
      if (this.gate) await this.gate;
      if (this.calls.filter(([name]) => name === 'close').length > closes) return;
      if (this.state === 'disconnected')
        throw new DOMException('The port is disconnected.', 'InvalidStateError');
      this.connection = 'open';
    } finally {
      this.opening = false;
    }
  }

  clear() {
    this.calls.push(['clear']);
    for (const item of this.scheduled) {
      item.cancelled = true;
      clearTimeout(item.timer);
    }
    this.scheduled = [];
  }

  async close() {
    this.calls.push(['close']);
    if (this.closeGate) await this.closeGate;
    this.clear();
    this.connection = 'closed';
    this.onmidimessage = null;
  }

  async send(data, timestamp) {
    this.calls.push(['send', data, timestamp]);
    if (this.type !== 'output')
      throw new DOMException('The port is not an output.', 'InvalidAccessError');
    if (this.connection !== 'open')
      throw new DOMException('The port is not open.', 'InvalidStateError');
    if (this.state === 'disconnected')
      throw new DOMException('The port is disconnected.', 'InvalidStateError');
    const bytes = new Uint8Array(data);
    const delay = timestamp === undefined ? 0 : Math.max(0, Number(timestamp) - performance.now());
    if (delay === 0) {
      this.sent.push({ bytes, timestamp });
      return;
    }
    const item = { cancelled: false, timer: null };
    item.timer = setTimeout(() => {
      if (item.cancelled || this.connection !== 'open') return;
      this.sent.push({ bytes, timestamp });
    }, delay);
    this.scheduled.push(item);
  }

  input(data, timestamp = 0) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const event = { data: bytes, timeStamp: timestamp };
    if (typeof this.onmidimessage === 'function') this.onmidimessage(event);
  }

  unplug() {
    this.state = 'disconnected';
    this.connection = 'closed';
    this.midi?.unplug(this);
  }

  plugBack() {
    this.state = 'connected';
    this.midi?.plug(this);
  }
}

export class FakeMIDIAccess extends EventTarget {
  constructor({ inputs = [], outputs = [], sysex = false } = {}) {
    super();
    this.sysexEnabled = sysex;
    this.inputs = new Map();
    this.outputs = new Map();
    this.onstatechange = null;
    for (const port of inputs) this.own(port, 'input');
    for (const port of outputs) this.own(port, 'output');
  }

  own(port, type) {
    const owned =
      port instanceof FakeMIDIPort ? port : new FakeMIDIPort({ ...port, type: port.type ?? type });
    owned.type = type ?? owned.type;
    owned.midi = this;
    const map = owned.type === 'input' ? this.inputs : this.outputs;
    map.set(owned.id, owned);
    return owned;
  }

  fire(port) {
    const event = { port };
    if (typeof this.onstatechange === 'function') this.onstatechange(event);
    this.dispatchEvent(new Event('statechange'));
  }

  unplug(port) {
    port.state = 'disconnected';
    port.connection = 'closed';
    this.fire(port);
  }

  plug(port) {
    const owned = this.own(port, port.type);
    owned.state = 'connected';
    this.fire(owned);
    return owned;
  }
}

export class FakeMIDI {
  constructor({
    inputs = [],
    outputs = [],
    grant = true,
    sysexGrant = true,
    gate = null,
    onRequest = null,
  } = {}) {
    this.inputs = inputs;
    this.outputs = outputs;
    this.grant = grant;
    this.sysexGrant = sysexGrant;
    this.gate = gate;
    this.onRequest = onRequest;
    this.calls = [];
    this.access = null;
  }

  async requestAccess(options = {}) {
    this.calls.push(['requestMIDIAccess', options]);
    this.onRequest?.(options);
    if (this.gate) await this.gate;
    const sysex = options.sysex === true;
    if (!this.grant || (sysex && !this.sysexGrant))
      throw new DOMException('MIDI access denied.', 'NotAllowedError');
    this.access = new FakeMIDIAccess({
      inputs: this.inputs,
      outputs: this.outputs,
      sysex,
    });
    for (const port of [...this.access.inputs.values(), ...this.access.outputs.values()])
      port.midi = this.access;
    return this.access;
  }
}

export function install(target, fakes = {}) {
  const midi = fakes.midi instanceof FakeMIDI ? fakes.midi : new FakeMIDI(fakes.midi ?? {});
  const installed = {
    serial: new FakeSerial(),
    usb: new FakeUSB(),
    hid: new FakeHID(),
    bluetooth: new FakeBluetooth(),
    midi,
    ...fakes,
  };
  installed.midi = midi;
  for (const [name, value] of Object.entries(installed)) {
    if (name === 'midi') continue;
    Object.defineProperty(target, name, { value, configurable: true });
  }
  Object.defineProperty(target, 'requestMIDIAccess', {
    value: (options) => midi.requestAccess(options ?? {}),
    configurable: true,
  });
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
