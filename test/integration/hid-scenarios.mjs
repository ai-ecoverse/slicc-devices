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
const LIMIT = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function world({ devices, fake }, { devices: granted = [], choose, active = false, enabled } = {}) {
  const hid = new fake.FakeHID({ devices: granted, choose });
  const navigator = { hid, userActivation: { isActive: active } };
  const overrides = { navigator };
  if (enabled) overrides.hidEnabled = enabled;
  const page = devices.create(overrides);
  const lines = [];
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(fake.request(kind, options, { progress: (line) => lines.push(line), ...fields }));
  return { page, hid, navigator, lines, ask };
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

function pad(fake, extra = {}) {
  return new fake.FakeHIDDevice(
    {
      vendorId: 0x320f,
      productId: 0x5044,
      productName: 'Nano Pad',
      collections: [{ usagePage: 0xff60, usage: 0x61 }],
    },
    extra
  );
}

export const rows = {
  list: {
    title: 'lists granted HID devices in handle order with collections',
    async run(deps) {
      const { fake } = deps;
      const granted = [
        pad(fake),
        new fake.FakeHIDDevice({
          vendorId: 0x1234,
          productId: 0x5678,
          productName: 'Probe',
          collections: [{ usagePage: 0xff00, usage: 1 }],
        }),
      ];
      const { ask } = world(deps, { devices: granted });
      const first = await reply(ask('hid.list'), fake);
      return JSON.parse(first.text).map(
        ({ handle, vendorId, productId, productName, opened, usagePage, usage }) => ({
          handle,
          vendorId,
          productId,
          productName,
          opened,
          usagePage,
          usage,
        })
      );
    },
    expected: [
      {
        handle: 'hid1',
        vendorId: 0x320f,
        productId: 0x5044,
        productName: 'Nano Pad',
        opened: false,
        usagePage: 0xff60,
        usage: 0x61,
      },
      {
        handle: 'hid2',
        vendorId: 0x1234,
        productId: 0x5678,
        productName: 'Probe',
        opened: false,
        usagePage: 0xff00,
        usage: 1,
      },
    ],
  },
  requestTyped: {
    title: 'requestDevice runs at once when typed and active, with no prompt',
    async run(deps) {
      const { fake } = deps;
      const board = pad(fake);
      const { ask, lines, hid } = world(deps, {
        choose: () => board,
        active: true,
      });
      const got = await reply(
        ask('hid.request', { filters: [{ vendorId: 0x320f }] }, { stamp: typist }),
        fake
      );
      return {
        devices: JSON.parse(got.text).map((d) => d.handle),
        lines,
        calls: hid.calls.filter(([name]) => name === 'requestDevice'),
      };
    },
    expected: {
      devices: ['hid1'],
      lines: [],
      calls: [['requestDevice', { filters: [{ vendorId: 0x320f }] }]],
    },
  },
  requestClick: {
    title: 'request sends the click-needed progress line and prompt entry for bios',
    async run(deps) {
      const { devices, fake } = deps;
      const board = pad(fake);
      const hid = new fake.FakeHID({ choose: () => board });
      const page = devices.create({
        navigator: { hid, userActivation: { isActive: false } },
      });
      const lines = [];
      const asked = fake.request(
        'hid.request',
        { filters: [] },
        { stamp: agent, progress: (line) => lines.push(line) }
      );
      const prompt = await page.prompts['hid.request'](asked);
      const got = await reply(page.handle(asked), fake);
      return { prompt, lines, handle: JSON.parse(got.text)[0].handle };
    },
    expected: {
      prompt: {
        title: 'Choose a HID device',
        body: "The agent cone wants to use a HID device. Click Choose, then pick it in the browser's list.",
        action: 'Choose…',
        cancel: 'Cancel',
        variant: 'confirmation',
        dismissed: 'no HID device was chosen',
        late: 'nobody clicked within 5 min',
      },
      lines: ["waiting for a click in seven's tab: choose a HID device"],
      handle: 'hid1',
    },
  },
  requestMulti: {
    title: 'request registers every granted interface as its own handle',
    async run(deps) {
      const { fake } = deps;
      const raw = new fake.FakeHIDDevice({
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'Nano Pad',
        collections: [{ usagePage: 0xff60, usage: 0x61 }],
      });
      const keys = new fake.FakeHIDDevice({
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'Nano Pad',
        collections: [{ usagePage: 1, usage: 6 }],
      });
      const { ask } = world(deps, { choose: () => [keys, raw], active: true });
      const got = await reply(
        ask(
          'hid.request',
          { filters: [{ vendorId: 0x320f, usagePage: 0xff60 }] },
          { stamp: typist }
        ),
        fake
      );
      return JSON.parse(got.text).map(({ handle, usagePage, usage }) => ({
        handle,
        usagePage,
        usage,
      }));
    },
    expected: [
      { handle: 'hid1', usagePage: 1, usage: 6 },
      { handle: 'hid2', usagePage: 0xff60, usage: 0x61 },
    ],
  },
  openClose: {
    title: 'opens and closes a device, and watches open/close for bios',
    async run(deps) {
      const { fake } = deps;
      const { page, ask } = world(deps, { devices: [pad(fake)] });
      const events = [];
      page.devices.hid.watch((event) => events.push(event.type));
      await ask('hid.open', { handle: 'hid1' }, { stamp: typist });
      const listed = page.devices.hid.list();
      await ask('hid.close', { handle: 'hid1' }, { stamp: typist });
      return {
        events,
        opened: listed[0].opened,
        after: page.devices.hid.list()[0].opened,
      };
    },
    expected: { events: ['open', 'close'], opened: true, after: false },
  },
  watch: {
    title: 'streams framed input reports until the request ends, and refuses a second watcher',
    async run(deps) {
      const { fake } = deps;
      const board = pad(fake);
      const { ask } = world(deps, { devices: [board] });
      await ask('hid.open', { handle: 'hid1' }, { stamp: typist });
      const controller = new AbortController();
      const stream = await ask(
        'hid.watch',
        { handle: 'hid1' },
        { stamp: typist, signal: controller.signal }
      );
      const second = await caught(ask('hid.watch', { handle: 'hid1' }, { stamp: typist }), fake);
      const reader = stream.getReader();
      board.input(3, new Uint8Array([0x01, 0x02]));
      const first = await reader.read();
      controller.abort();
      const end = await reader.read();
      return {
        second,
        frame: first.value ? [...first.value] : null,
        done: end.done,
      };
    },
    expected: {
      second: {
        name: 'InvalidStateError',
        message: 'another watch is in progress on hid1',
        errno: 'EIO',
      },
      frame: [3, 1, 2],
      done: true,
    },
  },
  sendAndFeature: {
    title: 'sends output and feature reports, and receives a feature report',
    async run(deps) {
      const { fake } = deps;
      const board = pad(fake, { feature: new Uint8Array([9, 8]) });
      const { ask } = world(deps, { devices: [board] });
      await ask(
        'hid.send',
        { handle: 'hid1', reportId: 0 },
        { stamp: typist, body: fake.bytes(new Uint8Array([1, 2])) }
      );
      await ask(
        'hid.send-feature',
        { handle: 'hid1', reportId: 1 },
        { stamp: typist, body: fake.bytes(new Uint8Array([3])) }
      );
      const got = await fake.collect(
        await ask('hid.receive-feature', { handle: 'hid1', reportId: 2 }, { stamp: typist })
      );
      return {
        sent: board.sent.map((s) => ({ reportId: s.reportId, bytes: [...s.bytes] })),
        features: board.features.map((f) => ({
          reportId: f.reportId,
          direction: f.direction,
          bytes: [...f.bytes],
        })),
        got: [...got],
        opened: board.opened,
      };
    },
    expected: {
      sent: [{ reportId: 0, bytes: [1, 2] }],
      features: [
        { reportId: 1, direction: 'out', bytes: [3] },
        { reportId: 2, direction: 'in', bytes: [9, 8] },
      ],
      got: [9, 8],
      opened: true,
    },
  },
  sizeCap: {
    title: 'refuses a report over 64 KiB',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { devices: [pad(fake)] });
      return caught(
        ask(
          'hid.send',
          { handle: 'hid1', reportId: 0 },
          { stamp: typist, body: fake.bytes(new Uint8Array(LIMIT + 1)) }
        ),
        fake
      );
    },
    expected: {
      name: 'QuotaExceededError',
      message: 'a HID report is at most 64 KiB',
      errno: 'EIO',
    },
  },
  missing: {
    title: 'answers ENOTSUP when WebHID is missing',
    async run(deps) {
      const { devices, fake } = deps;
      const page = devices.create({ navigator: {} });
      return caught(page.handle(fake.request('hid.list')), fake);
    },
    expected: {
      name: 'NotSupportedError',
      message: 'this browser has no WebHID (use Chrome, Edge or Opera on a desktop)',
      errno: 'ENOTSUP',
    },
  },
  protectedUsage: {
    title: "passes through Chrome's protected-usage refusal",
    async run(deps) {
      const { fake } = deps;
      const board = pad(fake, {
        protected: {
          name: 'NotAllowedError',
          message: 'A device with protected usages was requested.',
        },
      });
      const { ask } = world(deps, { devices: [board] });
      return caught(ask('hid.open', { handle: 'hid1' }, { stamp: typist }), fake);
    },
    expected: {
      name: 'NotAllowedError',
      message: 'A device with protected usages was requested.',
      errno: 'EACCES',
    },
  },
  unplugWatch: {
    title: 'unplug during a watch ends with EIO',
    async run(deps) {
      const { fake } = deps;
      const board = pad(fake);
      const { ask, hid } = world(deps, { devices: [board] });
      await ask('hid.open', { handle: 'hid1' }, { stamp: typist });
      const stream = await ask('hid.watch', { handle: 'hid1' }, { stamp: typist });
      const pending = reply(fake.collect(stream), fake);
      await sleep(10);
      board.dead = true;
      hid.unplug(board);
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'hid1 was unplugged',
      errno: 'EIO',
    },
  },
  unplugSend: {
    title: 'unplug during a send ends with EIO',
    async run(deps) {
      const { fake } = deps;
      let proceed;
      const gate = new Promise((resolve) => {
        proceed = resolve;
      });
      const board = pad(fake);
      const send = board.sendReport.bind(board);
      board.sendReport = async (...args) => {
        await gate;
        return send(...args);
      };
      const { ask, hid } = world(deps, { devices: [board] });
      await ask('hid.open', { handle: 'hid1' }, { stamp: typist });
      const pending = caught(
        ask(
          'hid.send',
          { handle: 'hid1', reportId: 0 },
          { stamp: typist, body: fake.bytes(new Uint8Array([1])) }
        ),
        fake
      );
      await sleep(10);
      board.dead = true;
      hid.unplug(board);
      proceed();
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'hid1 was unplugged',
      errno: 'EIO',
    },
  },
  reenumerate: {
    title: 're-enumeration with the same vid:pid and usage keeps the handle',
    async run(deps) {
      const { fake } = deps;
      const first = pad(fake);
      const { ask, hid, page } = world(deps, { devices: [first] });
      await ask('hid.open', { handle: 'hid1' }, { stamp: typist });
      await ask('hid.close', { handle: 'hid1' }, { stamp: typist });
      first.unplug();
      const again = pad(fake);
      hid.plug(again);
      const listed = JSON.parse((await reply(ask('hid.list'), fake)).text);
      return {
        handle: listed[0]?.handle,
        opened: listed[0]?.opened,
        devices: page.devices.hid.list().map((d) => d.handle),
      };
    },
    expected: { handle: 'hid1', opened: false, devices: ['hid1'] },
  },
  switchDuringOpen: {
    title: 'closeAll during a pending open fails it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const board = pad(fake, { gate });
      const hid = new fake.FakeHID({ devices: [board] });
      const page = devices.create({
        navigator: { hid },
        hidEnabled: () => on,
      });
      const opening = page.handle(fake.request('hid.open', { handle: 'hid1' }));
      await sleep(10);
      on = false;
      await page.devices.hid.closeAll();
      release();
      const refused = await caught(opening, fake);
      const later = await caught(page.handle(fake.request('hid.list')), fake);
      return { refused, later };
    },
    expected: {
      refused: {
        name: 'NotAllowedError',
        message: "HID devices are off in seven's settings",
        errno: 'EACCES',
      },
      later: {
        name: 'NotAllowedError',
        message: "HID devices are off in seven's settings",
        errno: 'EACCES',
      },
    },
  },
  switchDuringWatch: {
    title: 'closeAll during a watch ends it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const board = pad(fake);
      const hid = new fake.FakeHID({ devices: [board] });
      const page = devices.create({
        navigator: { hid },
        hidEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('hid.open', { handle: 'hid1' });
      const stream = await ask('hid.watch', { handle: 'hid1' });
      const pending = reply(fake.collect(stream), fake);
      await sleep(10);
      on = false;
      await page.devices.hid.closeAll();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "HID devices are off in seven's settings",
      errno: 'EACCES',
    },
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
      const board = pad(fake);
      const hid = new fake.FakeHID({
        choose: async () => {
          await gate;
          return board;
        },
      });
      const page = devices.create({
        navigator: { hid },
        hidEnabled: () => on,
      });
      const pending = caught(
        page.handle(fake.request('hid.request', { filters: [] }, { stamp: typist })),
        fake
      );
      await sleep(10);
      on = false;
      await page.devices.hid.closeAll();
      release();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "HID devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
};
