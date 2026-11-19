const agent = {
  pid: 7,
  uid: 1000,
  gid: 1000,
  tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
};
const typist = {
  pid: 8,
  uid: 0,
  gid: 0,
  tag: JSON.stringify({ kind: 'user', where: 'terminal:1' }),
};
const LIMIT = 512;
const NOTIFY_BUFFER = 64;
const HR = '0000180d-0000-1000-8000-00805f9b34fb';
const HRM = '00002a37-0000-1000-8000-00805f9b34fb';
const BSL = '00002a38-0000-1000-8000-00805f9b34fb';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = {
  name: 'NoModificationAllowedError',
  message: `another operation is in progress on ${HR}:${HRM}`,
  errno: 'EBUSY',
};

function world(
  { devices, fake },
  { devices: granted = [], choose, active = false, enabled, getDevices = true } = {}
) {
  const bluetooth = new fake.FakeBluetooth({ devices: granted, choose, getDevices });
  const navigator = { bluetooth, userActivation: { isActive: active } };
  const overrides = { navigator };
  if (enabled) overrides.bleEnabled = enabled;
  const page = devices.create(overrides);
  const lines = [];
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(fake.request(kind, options, { progress: (line) => lines.push(line), ...fields }));
  return { page, bluetooth, navigator, lines, ask };
}

async function caught(promise, fake) {
  try {
    await promise;
    return null;
  } catch (error) {
    return { name: error.name, message: error.message, errno: fake.errno(error) };
  }
}

async function reply(promise, fake) {
  try {
    return { text: await fake.drain(await promise) };
  } catch (error) {
    return { name: error.name, message: error.message, errno: fake.errno(error) };
  }
}

function strap(fake, extra = {}) {
  return new fake.FakeBluetoothDevice({ name: 'Polar H10', id: 'polar-1' }, extra);
}

function gated(fake, extra = {}) {
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const board = strap(fake, { ...extra, gate, onConnect: () => started() });
  return { board, release, entered };
}

export const rows = {
  list: {
    title: 'lists granted BLE devices in handle order',
    async run(deps) {
      const { fake } = deps;
      const granted = [
        strap(fake),
        new fake.FakeBluetoothDevice(
          { name: 'Battery', id: 'bat-1' },
          {
            services: [
              new fake.FakeBluetoothService('battery_service', [
                new fake.FakeBluetoothCharacteristic('battery_level', {
                  properties: { read: true, notify: true },
                  value: new Uint8Array([0x50]),
                }),
              ]),
            ],
          }
        ),
      ];
      const { ask } = world(deps, { devices: granted });
      const first = await reply(ask('ble.list'), fake);
      return JSON.parse(first.text).map(({ handle, id, name, connected }) => ({
        handle,
        id,
        name,
        connected,
      }));
    },
    expected: [
      { handle: 'ble1', id: 'polar-1', name: 'Polar H10', connected: false },
      { handle: 'ble2', id: 'bat-1', name: 'Battery', connected: false },
    ],
  },
  requestTyped: {
    title: 'requestDevice runs at once when typed and active, with no prompt',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask, lines, bluetooth } = world(deps, {
        choose: () => board,
        active: true,
      });
      const got = await reply(
        ask(
          'ble.request',
          { filters: [{ services: ['heart_rate'] }], optionalServices: ['heart_rate'] },
          { stamp: typist }
        ),
        fake
      );
      return {
        device: JSON.parse(got.text).handle,
        lines,
        calls: bluetooth.calls.filter(([name]) => name === 'requestDevice'),
      };
    },
    expected: {
      device: 'ble1',
      lines: [],
      calls: [
        [
          'requestDevice',
          {
            filters: [{ services: [HR] }],
            optionalServices: [HR],
          },
        ],
      ],
    },
  },
  requestClick: {
    title: 'request sends the click-needed progress line and prompt entry for bios',
    async run(deps) {
      const { devices, fake } = deps;
      const board = strap(fake);
      const bluetooth = new fake.FakeBluetooth({ choose: () => board });
      const page = devices.create({
        navigator: { bluetooth, userActivation: { isActive: false } },
      });
      const lines = [];
      const asked = fake.request(
        'ble.request',
        { filters: [{ services: ['heart_rate'] }] },
        { stamp: agent, progress: (line) => lines.push(line) }
      );
      const prompt = await page.prompts['ble.request'](asked);
      const got = await reply(page.handle(asked), fake);
      return { prompt, lines, handle: JSON.parse(got.text).handle };
    },
    expected: {
      prompt: {
        title: 'Choose a Bluetooth device',
        body: "The agent cone wants to use a Bluetooth device. Click Choose, then pick it in the browser's list.",
        action: 'Choose…',
        cancel: 'Cancel',
        variant: 'confirmation',
        dismissed: 'no Bluetooth device was chosen',
        late: 'nobody clicked within 5 min',
      },
      lines: ["waiting for a click in seven's tab: choose a Bluetooth device"],
      handle: 'ble1',
    },
  },
  connectDisconnect: {
    title: 'connects and disconnects, and watches open/close for bios',
    async run(deps) {
      const { fake } = deps;
      const { page, ask } = world(deps, { devices: [strap(fake)] });
      const events = [];
      page.devices.ble.watch((event) => events.push(event.type));
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const listed = page.devices.ble.list();
      await ask('ble.disconnect', { handle: 'ble1' }, { stamp: typist });
      return {
        events,
        connected: listed[0].connected,
        after: page.devices.ble.list()[0].connected,
      };
    },
    expected: { events: ['open', 'close'], connected: true, after: false },
  },
  services: {
    title: 'lists primary services, characteristics and descriptors as JSON',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { devices: [strap(fake)] });
      const got = await reply(ask('ble.services', { handle: 'ble1' }, { stamp: typist }), fake);
      const services = JSON.parse(got.text);
      return {
        uuid: services[0].uuid,
        chars: services[0].characteristics.map((c) => ({
          uuid: c.uuid,
          notify: Boolean(c.properties.notify),
          read: Boolean(c.properties.read),
        })),
      };
    },
    expected: {
      uuid: HR,
      chars: [
        { uuid: HRM, notify: true, read: true },
        { uuid: BSL, notify: false, read: true },
      ],
    },
  },
  read: {
    title: 'reads a characteristic value',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { devices: [strap(fake)] });
      const got = await fake.collect(
        await ask(
          'ble.read',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
          { stamp: typist }
        )
      );
      return [...got];
    },
    expected: [1],
  },
  notify: {
    title:
      'streams framed notification values until the request ends, and refuses a second notifier',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const controller = new AbortController();
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist, signal: controller.signal }
      );
      const second = await caught(
        ask(
          'ble.notify',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
          { stamp: typist }
        ),
        fake
      );
      const reader = stream.getReader();
      const char = board.services[0].characteristics[0];
      char.notify(new Uint8Array([0x06, 0x48]));
      const first = await reader.read();
      controller.abort();
      const end = await reader.read();
      return {
        second,
        frame: first.value ? [...first.value] : null,
        done: end.done,
        stopped: char.calls.some(([name]) => name === 'stopNotifications'),
      };
    },
    expected: {
      second: busy,
      frame: [6, 72],
      done: true,
      stopped: true,
    },
  },
  write: {
    title: 'writes a characteristic value whole',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask(
        'ble.write',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
        { stamp: typist, body: fake.bytes(new Uint8Array([2])) }
      );
      const char = board.services[0].characteristics[1];
      return {
        writes: char.writes.map((w) => ({ bytes: [...w.bytes], noResponse: w.noResponse })),
      };
    },
    expected: { writes: [{ bytes: [2], noResponse: false }] },
  },
  writeNoResponse: {
    title: 'writes without a response when noResponse is set',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask(
        'ble.write',
        {
          handle: 'ble1',
          service: 'heart_rate',
          characteristic: 'body_sensor_location',
          noResponse: true,
        },
        { stamp: typist, body: fake.bytes(new Uint8Array([3])) }
      );
      const char = board.services[0].characteristics[1];
      return {
        writes: char.writes.map((w) => ({ bytes: [...w.bytes], noResponse: w.noResponse })),
        calls: char.calls.map(([name]) => name),
      };
    },
    expected: {
      writes: [{ bytes: [3], noResponse: true }],
      calls: ['writeValueWithoutResponse'],
    },
  },
  sizeCap: {
    title: 'refuses a write over 512 bytes',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { devices: [strap(fake)] });
      return caught(
        ask(
          'ble.write',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
          { stamp: typist, body: fake.bytes(new Uint8Array(LIMIT + 1)) }
        ),
        fake
      );
    },
    expected: {
      name: 'QuotaExceededError',
      message: 'a BLE write is at most 512 bytes',
      errno: 'EIO',
    },
  },
  missing: {
    title: 'answers ENOTSUP when Web Bluetooth is missing',
    async run(deps) {
      const { devices, fake } = deps;
      const page = devices.create({ navigator: {} });
      return caught(page.handle(fake.request('ble.list')), fake);
    },
    expected: {
      name: 'NotSupportedError',
      message: 'this browser has no Web Bluetooth (use Chrome, Edge or Opera on a desktop)',
      errno: 'ENOTSUP',
    },
  },
  unlistedService: {
    title: 'names --service when a service was not listed in optionalServices',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake, { allowed: new Set() });
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      return caught(
        ask(
          'ble.read',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
          { stamp: typist }
        ),
        fake
      );
    },
    expected: {
      name: 'NotAllowedError',
      message:
        "Origin is not allowed to access any service. Tip: Add the service UUID to 'optionalServices' in requestDevice() options. (add --service heart_rate)",
      errno: 'EACCES',
    },
  },
  disconnectNotify: {
    title: 'disconnect during a notification ends with EIO',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      const pending = reply(fake.collect(stream), fake);
      await sleep(10);
      board.gatt.disconnect();
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'ble1 was disconnected',
      errno: 'EIO',
    },
  },
  disconnectWrite: {
    title: 'disconnect during a write ends with EIO',
    async run(deps) {
      const { fake } = deps;
      let proceed;
      const gate = new Promise((resolve) => {
        proceed = resolve;
      });
      const board = strap(fake);
      const char = board.services[0].characteristics[1];
      char.gate = gate;
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const pending = caught(
        ask(
          'ble.write',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
          { stamp: typist, body: fake.bytes(new Uint8Array([1])) }
        ),
        fake
      );
      await sleep(10);
      board.gatt.disconnect();
      proceed();
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'ble1 was disconnected',
      errno: 'EIO',
    },
  },
  reenumerate: {
    title: 're-seen device with the same id keeps the handle',
    async run(deps) {
      const { fake } = deps;
      const first = strap(fake);
      const { ask, bluetooth, page } = world(deps, { devices: [first] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      await ask('ble.disconnect', { handle: 'ble1' }, { stamp: typist });
      first.unplug();
      const again = strap(fake);
      bluetooth.devices.push(bluetooth.own(again));
      const listed = JSON.parse((await reply(ask('ble.list'), fake)).text);
      return {
        handle: listed[0]?.handle,
        connected: listed[0]?.connected,
        devices: page.devices.ble.list().map((d) => d.handle),
      };
    },
    expected: { handle: 'ble1', connected: false, devices: ['ble1'] },
  },
  closeDuringConnect: {
    title: 'ble.disconnect during a pending connect leaves the device disconnected',
    async run(deps) {
      const { fake } = deps;
      const { board, release, entered } = gated(fake);
      const { ask, page } = world(deps, { devices: [board] });
      const events = [];
      page.devices.ble.watch((event) => events.push(event.type));
      const connecting = ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      await entered;
      const closing = ask('ble.disconnect', { handle: 'ble1' }, { stamp: typist });
      release();
      const refused = await caught(connecting, fake);
      await closing;
      return {
        refused,
        deviceConnected: board.gatt.connected,
        listedConnected: page.devices.ble.list()[0].connected,
        opened: events.includes('open'),
      };
    },
    expected: {
      refused: {
        name: 'InvalidStateError',
        message: 'ble1 is not connected (ble connect ble1)',
        errno: 'EIO',
      },
      deviceConnected: false,
      listedConnected: false,
      opened: false,
    },
  },
  reopenAfterCancel: {
    title: 'ble.connect after disconnect during a pending connect succeeds',
    async run(deps) {
      const { fake } = deps;
      const { board, release, entered } = gated(fake);
      const { ask, page } = world(deps, { devices: [board] });
      const first = ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      await entered;
      await ask('ble.disconnect', { handle: 'ble1' }, { stamp: typist });
      const second = ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      release();
      const refused = await caught(first, fake);
      await second;
      return {
        refused,
        deviceConnected: board.gatt.connected,
        listedConnected: page.devices.ble.list()[0].connected,
        connects: board.calls.filter(([name]) => name === 'gatt.connect').length,
      };
    },
    expected: {
      refused: {
        name: 'InvalidStateError',
        message: 'ble1 is not connected (ble connect ble1)',
        errno: 'EIO',
      },
      deviceConnected: true,
      listedConnected: true,
      connects: 2,
    },
  },
  switchDuringConnect: {
    title: 'closeAll during a pending connect fails it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const { board, release, entered } = gated(fake);
      const bluetooth = new fake.FakeBluetooth({ devices: [board] });
      const page = devices.create({
        navigator: { bluetooth },
        bleEnabled: () => on,
      });
      const connecting = page.handle(fake.request('ble.connect', { handle: 'ble1' }));
      await entered;
      on = false;
      await page.devices.ble.closeAll();
      release();
      const refused = await caught(connecting, fake);
      const later = await caught(page.handle(fake.request('ble.list')), fake);
      return { refused, later };
    },
    expected: {
      refused: {
        name: 'NotAllowedError',
        message: "Bluetooth devices are off in seven's settings",
        errno: 'EACCES',
      },
      later: {
        name: 'NotAllowedError',
        message: "Bluetooth devices are off in seven's settings",
        errno: 'EACCES',
      },
    },
  },
  switchDuringNotify: {
    title: 'closeAll during a notify ends it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const board = strap(fake);
      const bluetooth = new fake.FakeBluetooth({ devices: [board] });
      const page = devices.create({
        navigator: { bluetooth },
        bleEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('ble.connect', { handle: 'ble1' });
      const stream = await ask('ble.notify', {
        handle: 'ble1',
        service: 'heart_rate',
        characteristic: 'heart_rate_measurement',
      });
      const pending = reply(fake.collect(stream), fake);
      await sleep(10);
      on = false;
      await page.devices.ble.closeAll();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "Bluetooth devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  abortDuringStart: {
    title: 'abort during a pending startNotifications stops again once start settles',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const char = board.services[0].characteristics[0];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      char.gate = gate;
      const controller = new AbortController();
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist, signal: controller.signal }
      );
      const reader = stream.getReader();
      while (!char.calls.some(([name]) => name === 'startNotifications')) await sleep(1);
      controller.abort();
      release();
      const end = await reader.read();
      while (char.notifying) await sleep(1);
      return {
        done: end.done,
        notifying: char.notifying,
        stops: char.calls.filter(([name]) => name === 'stopNotifications').length,
        starts: char.calls.filter(([name]) => name === 'startNotifications').length,
      };
    },
    expected: { done: true, notifying: false, stops: 2, starts: 1 },
  },
  switchDuringStart: {
    title: 'closeAll during a pending startNotifications stops again once start settles',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const board = strap(fake);
      const char = board.services[0].characteristics[0];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const bluetooth = new fake.FakeBluetooth({ devices: [board] });
      const page = devices.create({
        navigator: { bluetooth },
        bleEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('ble.connect', { handle: 'ble1' });
      char.gate = gate;
      const stream = await ask('ble.notify', {
        handle: 'ble1',
        service: 'heart_rate',
        characteristic: 'heart_rate_measurement',
      });
      const pending = reply(fake.collect(stream), fake);
      while (!char.calls.some(([name]) => name === 'startNotifications')) await sleep(1);
      on = false;
      const closing = page.devices.ble.closeAll();
      release();
      const refused = await pending;
      await closing;
      while (char.calls.filter(([name]) => name === 'stopNotifications').length < 2) await sleep(1);
      return {
        refused,
        notifying: char.notifying,
        stops: char.calls.filter(([name]) => name === 'stopNotifications').length,
      };
    },
    expected: {
      refused: {
        name: 'NotAllowedError',
        message: "Bluetooth devices are off in seven's settings",
        errno: 'EACCES',
      },
      notifying: false,
      stops: 2,
    },
  },
  notifyBackpressure: {
    title: 'drops notify values when the reader is slow and reports the drop',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask, lines } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      const char = board.services[0].characteristics[0];
      while (!char.notifying) await sleep(1);
      for (let i = 0; i < NOTIFY_BUFFER + 3; i += 1) char.notify(new Uint8Array([i & 0xff]));
      const reader = stream.getReader();
      const first = await reader.read();
      await sleep(300);
      await reader.cancel();
      const dropped = lines
        .map((line) => line.match(/ble1: (\d+) values dropped \(nobody read in time\)/))
        .filter(Boolean)
        .reduce((sum, match) => sum + Number(match[1]), 0);
      return {
        first: first.value ? first.value[0] : null,
        dropped,
      };
    },
    expected: { first: 0, dropped: 3 },
  },
  notifyStopBusy: {
    title: 'a second notify while stopNotifications is still settling is EBUSY',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const char = board.services[0].characteristics[0];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const controller = new AbortController();
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist, signal: controller.signal }
      );
      while (!char.notifying) await sleep(1);
      char.stopGate = gate;
      controller.abort();
      while (!char.calls.some(([name]) => name === 'stopNotifications')) await sleep(1);
      const second = await caught(
        ask(
          'ble.notify',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
          { stamp: typist }
        ),
        fake
      );
      release();
      while (char.calls.filter(([name]) => name === 'stopNotifications').length < 1) await sleep(1);
      await sleep(10);
      const third = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      await third.cancel();
      void stream;
      return { second, third: third instanceof ReadableStream };
    },
    expected: { second: busy, third: true },
  },
  switchAfterStart: {
    title: 'turning the switch off after startNotifications settles ends the notify stream',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const board = strap(fake);
      const char = board.services[0].characteristics[0];
      const orig = char.startNotifications.bind(char);
      char.startNotifications = async () => {
        await orig();
        on = false;
      };
      const bluetooth = new fake.FakeBluetooth({ devices: [board] });
      const page = devices.create({
        navigator: { bluetooth },
        bleEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('ble.connect', { handle: 'ble1' });
      const stream = await ask('ble.notify', {
        handle: 'ble1',
        service: 'heart_rate',
        characteristic: 'heart_rate_measurement',
      });
      return reply(fake.collect(stream), fake);
    },
    expected: {
      name: 'NotAllowedError',
      message: "Bluetooth devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  disconnectBeforeCharacteristic: {
    title: 'disconnect after connect but before getCharacteristic ends the notify stream',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const service = board.services[0];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const orig = service.getCharacteristic.bind(service);
      service.getCharacteristic = async (...args) => {
        await gate;
        return orig(...args);
      };
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      const pending = reply(fake.collect(stream), fake);
      await sleep(10);
      board.gatt.disconnect();
      release();
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'ble1 was disconnected',
      errno: 'EIO',
    },
  },
  emptyNotify: {
    title: 'drops a zero-length notification so ble notify does not treat it as end of stream',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      const char = board.services[0].characteristics[0];
      while (!char.notifying) await sleep(1);
      char.notify(new Uint8Array(0));
      char.notify(new Uint8Array([0x06, 0x40]));
      const reader = stream.getReader();
      const first = await reader.read();
      await reader.cancel();
      return { first: first.value ? [...first.value] : null, done: first.done };
    },
    expected: { first: [6, 64], done: false },
  },
  gattDesyncReconnect: {
    title: 'reconnects when entry.connected is stale but gatt.connected is false',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask, page } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      board.gatt.connected = false;
      await ask(
        'ble.read',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'body_sensor_location' },
        { stamp: typist }
      );
      return {
        connected: board.gatt.connected,
        listed: page.devices.ble.list()[0].connected,
        connects: board.calls.filter(([name]) => name === 'gatt.connect').length,
      };
    },
    expected: { connected: true, listed: true, connects: 2 },
  },
  readDuringNotify: {
    title: 'read while a notify is active on the same characteristic is EBUSY',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const stream = await ask(
        'ble.notify',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      const refused = await caught(
        ask(
          'ble.read',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
          { stamp: typist }
        ),
        fake
      );
      await stream.cancel();
      return refused;
    },
    expected: busy,
  },
  notifyDuringRead: {
    title: 'notify while a read is in flight on the same characteristic is EBUSY',
    async run(deps) {
      const { fake } = deps;
      const board = strap(fake);
      const char = board.services[0].characteristics[0];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      char.gate = gate;
      const { ask } = world(deps, { devices: [board] });
      await ask('ble.connect', { handle: 'ble1' }, { stamp: typist });
      const reading = ask(
        'ble.read',
        { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
        { stamp: typist }
      );
      await sleep(10);
      const refused = await caught(
        ask(
          'ble.notify',
          { handle: 'ble1', service: 'heart_rate', characteristic: 'heart_rate_measurement' },
          { stamp: typist }
        ),
        fake
      );
      release();
      await reading;
      return refused;
    },
    expected: busy,
  },
  switchDuringRequest: {
    title: 'closeAll during a pending requestDevice fails it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const board = strap(fake);
      const bluetooth = new fake.FakeBluetooth({
        choose: async () => {
          await gate;
          return board;
        },
      });
      const page = devices.create({
        navigator: { bluetooth },
        bleEnabled: () => on,
      });
      const pending = caught(
        page.handle(
          fake.request(
            'ble.request',
            { filters: [{ services: ['heart_rate'] }] },
            { stamp: typist }
          )
        ),
        fake
      );
      await sleep(10);
      on = false;
      await page.devices.ble.closeAll();
      release();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "Bluetooth devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
};
