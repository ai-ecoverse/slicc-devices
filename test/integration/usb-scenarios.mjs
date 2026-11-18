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
const other = {
  pid: 9,
  uid: 0,
  gid: 0,
  tag: JSON.stringify({ kind: 'agent', agentId: 'other' }),
};
const LIMIT = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function world({ devices, fake }, { devices: granted = [], choose, active = false, enabled } = {}) {
  const usb = new fake.FakeUSB({ devices: granted, choose });
  const navigator = { usb, userActivation: { isActive: active } };
  const overrides = { navigator };
  if (enabled) overrides.usbEnabled = enabled;
  const page = devices.create(overrides);
  const lines = [];
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(fake.request(kind, options, { progress: (line) => lines.push(line), ...fields }));
  return { page, usb, navigator, lines, ask };
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

function arduino(fake, extra = {}) {
  return new fake.FakeUSBDevice(
    {
      vendorId: 0x2341,
      productId: 0x0043,
      productName: 'Arduino Uno',
      manufacturerName: 'Arduino LLC',
      serialNumber: 'UNO1',
      deviceClass: 2,
    },
    { configuration: fake.usbConfig(), ...extra }
  );
}

export const rows = {
  list: {
    title: 'lists granted USB devices in handle order with names and interfaces',
    async run(deps) {
      const { fake } = deps;
      const granted = [
        arduino(fake),
        new fake.FakeUSBDevice({ vendorId: 0x1234, productId: 0x5678, productName: 'Probe' }),
      ];
      const { ask } = world(deps, { devices: granted });
      const first = await reply(ask('usb.list'), fake);
      return JSON.parse(first.text).map(({ handle, vendorId, productId, productName, opened }) => ({
        handle,
        vendorId,
        productId,
        productName,
        opened,
      }));
    },
    expected: [
      {
        handle: 'usb1',
        vendorId: 0x2341,
        productId: 0x0043,
        productName: 'Arduino Uno',
        opened: false,
      },
      { handle: 'usb2', vendorId: 0x1234, productId: 0x5678, productName: 'Probe', opened: false },
    ],
  },
  requestTyped: {
    title: 'requestDevice runs at once when typed and active, with no prompt',
    async run(deps) {
      const { fake } = deps;
      const board = arduino(fake);
      const { ask, lines, usb } = world(deps, {
        choose: () => board,
        active: true,
      });
      const got = await reply(
        ask('usb.request', { filters: [{ vendorId: 0x2341 }] }, { stamp: typist }),
        fake
      );
      return {
        device: JSON.parse(got.text).handle,
        lines,
        calls: usb.calls.filter(([name]) => name === 'requestDevice'),
      };
    },
    expected: {
      device: 'usb1',
      lines: [],
      calls: [['requestDevice', { filters: [{ vendorId: 0x2341 }] }]],
    },
  },
  requestClick: {
    title: 'request sends the click-needed progress line and prompt entry for bios',
    async run(deps) {
      const { devices, fake } = deps;
      const board = arduino(fake);
      const usb = new fake.FakeUSB({ choose: () => board });
      const page = devices.create({
        navigator: { usb, userActivation: { isActive: false } },
      });
      const lines = [];
      const asked = fake.request(
        'usb.request',
        { filters: [] },
        { stamp: agent, progress: (line) => lines.push(line) }
      );
      const prompt = await page.prompts['usb.request'](asked);
      const got = await reply(page.handle(asked), fake);
      return { prompt, lines, handle: JSON.parse(got.text).handle };
    },
    expected: {
      prompt: {
        title: 'Choose a USB device',
        body: "The agent cone wants to use a USB device. Click Choose, then pick it in the browser's list.",
        action: 'Choose…',
        cancel: 'Cancel',
        variant: 'confirmation',
        dismissed: 'no USB device was chosen',
        late: 'nobody clicked within 5 min',
      },
      lines: ["waiting for a click in seven's tab: choose a USB device"],
      handle: 'usb1',
    },
  },
  openClose: {
    title: 'opens and closes a device, and watches open/close for bios',
    async run(deps) {
      const { fake } = deps;
      const { page, ask } = world(deps, { devices: [arduino(fake)] });
      const events = [];
      page.devices.usb.watch((event) => events.push(event.type));
      await ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      const listed = page.devices.usb.list();
      await ask('usb.close', { handle: 'usb1' }, { stamp: typist });
      return {
        events,
        opened: listed[0].opened,
        after: page.devices.usb.list()[0].opened,
      };
    },
    expected: { events: ['open', 'close'], opened: true, after: false },
  },
  claimExclusive: {
    title: 'refuses a second claim naming the holder, and --wait then takes it',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { devices: [arduino(fake)] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: agent });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const busy = await caught(
        ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: other }),
        fake
      );
      const waiting = ask(
        'usb.claim',
        { handle: 'usb1', interface: 0, wait: true },
        { stamp: other }
      );
      await sleep(20);
      await ask('usb.release', { handle: 'usb1', interface: 0 }, { stamp: agent });
      await waiting;
      return { busy };
    },
    expected: {
      busy: {
        name: 'NoModificationAllowedError',
        message: 'usb1 is claimed by agent:cone (usb claim --wait ...)',
        errno: 'EBUSY',
      },
    },
  },
  forceClose: {
    title: 'close --force displaces another holder with claim-lost',
    async run(deps) {
      const { fake } = deps;
      const { page, ask } = world(deps, { devices: [arduino(fake)] });
      const lost = [];
      page.devices.usb.watch((event) => {
        if (event.type === 'claim-lost') lost.push(event);
      });
      await ask('usb.open', { handle: 'usb1' }, { stamp: agent });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const refused = await caught(ask('usb.close', { handle: 'usb1' }, { stamp: other }), fake);
      await ask('usb.close', { handle: 'usb1', force: true }, { stamp: other });
      return {
        refused: refused.message,
        lost: lost.map(({ handle, holder, displacedBy, reason }) => ({
          handle,
          holder,
          displacedBy,
          reason,
        })),
      };
    },
    expected: {
      refused:
        "usb close 'usb1' interface 0 refused: held by agent:cone (pass --force to override)",
      lost: [{ handle: 'usb1', holder: 'agent:cone', displacedBy: 'agent:other', reason: 'close' }],
    },
  },
  transfers: {
    title: 'bulk IN and OUT, control, clear-halt, and the 4 MiB limit',
    async run(deps) {
      const { fake } = deps;
      const board = arduino(fake, {
        inData: new Uint8Array([1, 2, 3, 4]),
        controlIn: new Uint8Array([9, 8]),
      });
      const { ask } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await ask('usb.select', { handle: 'usb1', configuration: 1 }, { stamp: typist });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const inn = await fake.collect(
        await ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 4 }, { stamp: typist })
      );
      const out = await fake.drain(
        await ask(
          'usb.transfer.out',
          { handle: 'usb1', endpoint: 1 },
          { stamp: typist, body: fake.bytes(new Uint8Array([5, 6])) }
        )
      );
      const control = await fake.collect(
        await ask(
          'usb.control',
          {
            handle: 'usb1',
            length: 2,
            requestType: 'vendor',
            recipient: 'device',
            request: 1,
            value: 0,
            index: 0,
          },
          { stamp: typist }
        )
      );
      await ask(
        'usb.clear-halt',
        { handle: 'usb1', direction: 'in', endpoint: 1 },
        { stamp: typist }
      );
      const huge = await caught(
        ask(
          'usb.transfer.in',
          { handle: 'usb1', endpoint: 1, length: LIMIT + 1 },
          { stamp: typist }
        ),
        fake
      );
      return {
        inn: [...inn],
        out,
        control: [...control],
        huge: { name: huge.name, errno: huge.errno },
        written: [...board.written[0].bytes],
        cleared: board.calls.some((c) => c[0] === 'clearHalt'),
      };
    },
    expected: {
      inn: [1, 2, 3, 4],
      out: '2',
      control: [9, 8],
      huge: { name: 'QuotaExceededError', errno: 'EIO' },
      written: [5, 6],
      cleared: true,
    },
  },
  follow: {
    title: 'transfer.in follow streams until the request ends',
    async run(deps) {
      const { fake } = deps;
      let n = 0;
      const board = arduino(fake, {
        inData: () => new Uint8Array([n++]),
      });
      const { ask } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const stop = new AbortController();
      const stream = await ask(
        'usb.transfer.in',
        { handle: 'usb1', endpoint: 1, length: 1, follow: true },
        { stamp: typist, signal: stop.signal }
      );
      const reader = stream.getReader();
      const first = await reader.read();
      const second = await reader.read();
      stop.abort();
      const third = await reader.read();
      return {
        first: [...first.value],
        second: [...second.value],
        done: third.done,
      };
    },
    expected: { first: [0], second: [1], done: true },
  },
  reenumerate: {
    title: 're-enumeration with the same vid:pid and serial keeps the handle',
    async run(deps) {
      const { fake } = deps;
      const first = arduino(fake);
      const { ask, usb } = world(deps, { devices: [first] });
      await ask('usb.list');
      first.unplug();
      const again = arduino(fake);
      usb.plug(again);
      const listed = JSON.parse((await reply(ask('usb.list'), fake)).text);
      return listed.map(({ handle, serialNumber }) => ({ handle, serialNumber }));
    },
    expected: [{ handle: 'usb1', serialNumber: 'UNO1' }],
  },
  switchOff: {
    title: 'the USB switch refuses kinds and closeAll invalidates in-flight open',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const board = arduino(fake, { gate });
      const usb = new fake.FakeUSB({ devices: [board] });
      const page = devices.create({
        navigator: { usb },
        usbEnabled: () => on,
      });
      const opening = page.handle(fake.request('usb.open', { handle: 'usb1' }));
      await sleep(10);
      on = false;
      await page.devices.usb.closeAll();
      release();
      const refused = await caught(opening, fake);
      const later = await caught(page.handle(fake.request('usb.list')), fake);
      return { refused, later };
    },
    expected: {
      refused: {
        name: 'NotAllowedError',
        message: "USB devices are off in seven's settings",
        errno: 'EACCES',
      },
      later: {
        name: 'NotAllowedError',
        message: "USB devices are off in seven's settings",
        errno: 'EACCES',
      },
    },
  },
  missing: {
    title: 'answers ENOTSUP when WebUSB is missing',
    async run(deps) {
      const { devices, fake } = deps;
      const page = devices.create({ navigator: {} });
      return caught(page.handle(fake.request('usb.list')), fake);
    },
    expected: {
      name: 'NotSupportedError',
      message: 'this browser has no WebUSB (use Chrome, Edge or Opera on a desktop)',
      errno: 'ENOTSUP',
    },
  },
  unplug: {
    title: 'unplug during a transfer ends with EIO',
    async run(deps) {
      const { fake } = deps;
      let proceed;
      const gate = new Promise((resolve) => {
        proceed = resolve;
      });
      const board = arduino(fake, {
        inData: async () => {
          await gate;
          return new Uint8Array([1]);
        },
      });
      const { ask, usb } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const pending = reply(
        ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: typist }),
        fake
      );
      await sleep(10);
      board.dead = true;
      usb.unplug(board);
      proceed();
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'usb1 was unplugged',
      errno: 'EIO',
    },
  },
  claimOwnsTransfer: {
    title: 'refuses a second claimant transferring, and the holder succeeds',
    async run(deps) {
      const { fake } = deps;
      const board = arduino(fake, { inData: new Uint8Array([7]) });
      const { ask } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: agent });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const unclaimed = await caught(
        ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: other }),
        fake
      );
      const held = await fake.collect(
        await ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: agent })
      );
      await ask('usb.release', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const free = await caught(
        ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: agent }),
        fake
      );
      return { unclaimed, held: [...held], free };
    },
    expected: {
      unclaimed: {
        name: 'NoModificationAllowedError',
        message: 'usb1 is claimed by agent:cone',
        errno: 'EBUSY',
      },
      held: [7],
      free: {
        name: 'NoModificationAllowedError',
        message: 'usb1 interface 0 is not claimed (usb claim usb1 0)',
        errno: 'EBUSY',
      },
    },
  },
  endpointDirection: {
    title: 'maps an endpoint by address and direction on the active alternate',
    async run(deps) {
      const { fake } = deps;
      const board = new fake.FakeUSBDevice(
        {
          vendorId: 0x2341,
          productId: 0x43,
          productName: 'Split',
          serialNumber: 'S2',
        },
        {
          configuration: fake.usbConfig(1, [
            {
              interfaceNumber: 0,
              endpoints: [{ endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 }],
            },
            {
              interfaceNumber: 1,
              endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 }],
            },
          ]),
          inData: new Uint8Array([4]),
        }
      );
      const { ask } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const outOk = await fake.drain(
        await ask(
          'usb.transfer.out',
          { handle: 'usb1', endpoint: 1 },
          { stamp: typist, body: fake.bytes(new Uint8Array([1])) }
        )
      );
      const innRefused = await caught(
        ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: typist }),
        fake
      );
      await ask('usb.claim', { handle: 'usb1', interface: 1 }, { stamp: typist });
      const inn = await fake.collect(
        await ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }, { stamp: typist })
      );
      return { outOk, innRefused, inn: [...inn] };
    },
    expected: {
      outOk: '1',
      innRefused: {
        name: 'NoModificationAllowedError',
        message: 'usb1 interface 1 is not claimed (usb claim usb1 1)',
        errno: 'EBUSY',
      },
      inn: [4],
    },
  },
  transferStatus: {
    title: 'rejects stalled and babble transfer results without exposing bytes',
    async run(deps) {
      const { fake } = deps;
      const stallIn = arduino(fake, { inStatus: 'stall' });
      const babbleOut = arduino(fake, { outStatus: 'babble' });
      const stallControl = arduino(fake, { controlInStatus: 'stall' });
      const pageIn = world(deps, { devices: [stallIn] });
      await pageIn.ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await pageIn.ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const inn = await caught(
        fake.collect(
          await pageIn.ask(
            'usb.transfer.in',
            { handle: 'usb1', endpoint: 1, length: 1 },
            { stamp: typist }
          )
        ),
        fake
      );
      const pageOut = world(deps, { devices: [babbleOut] });
      await pageOut.ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      await pageOut.ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: typist });
      const out = await caught(
        pageOut.ask(
          'usb.transfer.out',
          { handle: 'usb1', endpoint: 1 },
          { stamp: typist, body: fake.bytes(new Uint8Array([1])) }
        ),
        fake
      );
      const pageCtl = world(deps, { devices: [stallControl] });
      await pageCtl.ask('usb.open', { handle: 'usb1' }, { stamp: typist });
      const ctl = await caught(
        pageCtl.ask(
          'usb.control',
          { handle: 'usb1', length: 1, recipient: 'device' },
          { stamp: typist }
        ),
        fake
      );
      return { inn, out, ctl };
    },
    expected: {
      inn: { name: 'NetworkError', message: 'The transfer stalled.', errno: 'EIO' },
      out: { name: 'NetworkError', message: 'The transfer babble.', errno: 'EIO' },
      ctl: { name: 'NetworkError', message: 'The transfer stalled.', errno: 'EIO' },
    },
  },
  claimLostControlOut: {
    title: 'force reset during a slow control OUT body drops the claim before the device write',
    async run(deps) {
      const { fake } = deps;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const board = arduino(fake);
      const { ask, page } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: agent });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const pending = caught(
        ask(
          'usb.control',
          { handle: 'usb1', recipient: 'interface', index: 0 },
          {
            stamp: agent,
            body: new ReadableStream({
              async pull(controller) {
                await gate;
                controller.enqueue(new Uint8Array([9]));
                controller.close();
              },
            }),
          }
        ),
        fake
      );
      await sleep(10);
      await ask('usb.reset', { handle: 'usb1', force: true }, { stamp: other });
      release();
      const refused = await pending;
      const listed = page.devices.usb.list()[0];
      return {
        refused,
        outs: board.controls.filter((c) => c.direction === 'out').length,
        opened: board.opened,
        claimed: listed.interfaces[0].claimed,
        holder: listed.interfaces[0].holder ?? null,
      };
    },
    expected: {
      refused: {
        name: 'NoModificationAllowedError',
        message: 'usb1 claim was lost',
        errno: 'EBUSY',
      },
      outs: 0,
      opened: true,
      claimed: false,
      holder: null,
    },
  },
  claimLostControlIn: {
    title: 'release during a slow control IN wait drops the claim before returning bytes',
    async run(deps) {
      const { fake } = deps;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const board = arduino(fake, {
        controlIn: async () => {
          await gate;
          return new Uint8Array([4]);
        },
      });
      const { ask, page } = world(deps, { devices: [board] });
      await ask('usb.open', { handle: 'usb1' }, { stamp: agent });
      await ask('usb.claim', { handle: 'usb1', interface: 0 }, { stamp: agent });
      const pending = reply(
        ask(
          'usb.control',
          { handle: 'usb1', length: 1, recipient: 'interface', index: 0 },
          { stamp: agent }
        ),
        fake
      );
      await sleep(10);
      await ask('usb.release', { handle: 'usb1', interface: 0 }, { stamp: agent });
      release();
      const refused = await pending;
      const listed = page.devices.usb.list()[0];
      return {
        refused,
        opened: board.opened,
        claimed: listed.interfaces[0].claimed,
        holder: listed.interfaces[0].holder ?? null,
      };
    },
    expected: {
      refused: {
        name: 'NoModificationAllowedError',
        message: 'usb1 claim was lost',
        errno: 'EBUSY',
      },
      opened: true,
      claimed: false,
      holder: null,
    },
  },
  switchDuringTransfers: {
    title:
      'closeAll during in-flight transfer.in/out, control and follow ends them with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      const sleepGate = () => {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        return { gate, release: () => release() };
      };
      const run = async (kind) => {
        let on = true;
        const hold = sleepGate();
        const board = arduino(fake, {
          inData: async () => {
            await hold.gate;
            return new Uint8Array([1]);
          },
          controlIn: async () => {
            await hold.gate;
            return new Uint8Array([2]);
          },
        });
        if (kind === 'out') {
          const send = board.transferOut.bind(board);
          board.transferOut = async (...args) => {
            await hold.gate;
            return send(...args);
          };
        }
        const usb = new fake.FakeUSB({ devices: [board] });
        const page = devices.create({
          navigator: { usb },
          usbEnabled: () => on,
        });
        const ask = (k, options = {}, fields = {}) =>
          page.handle(fake.request(k, options, { stamp: typist, ...fields }));
        await ask('usb.open', { handle: 'usb1' });
        await ask('usb.claim', { handle: 'usb1', interface: 0 });
        let pending;
        if (kind === 'in') {
          pending = reply(ask('usb.transfer.in', { handle: 'usb1', endpoint: 1, length: 1 }), fake);
        } else if (kind === 'out') {
          pending = caught(
            ask(
              'usb.transfer.out',
              { handle: 'usb1', endpoint: 1 },
              { body: fake.bytes(new Uint8Array([3])) }
            ),
            fake
          );
        } else if (kind === 'control') {
          pending = reply(
            ask('usb.control', { handle: 'usb1', length: 1, recipient: 'interface', index: 0 }),
            fake
          );
        } else {
          const stream = await ask('usb.transfer.in', {
            handle: 'usb1',
            endpoint: 1,
            length: 1,
            follow: true,
          });
          pending = reply(fake.collect(stream), fake);
        }
        await sleep(10);
        on = false;
        await page.devices.usb.closeAll();
        hold.release();
        const refused = await pending;
        const listed = page.devices.usb.list()[0];
        const reclaim = await caught(ask('usb.claim', { handle: 'usb1', interface: 0 }), fake);
        return {
          refused,
          opened: board.opened,
          claimed: listed?.interfaces?.[0]?.claimed ?? false,
          holder: listed?.interfaces?.[0]?.holder ?? null,
          written: board.written.length,
          controls: board.controls.length,
          reclaim,
        };
      };
      return {
        inn: await run('in'),
        out: await run('out'),
        control: await run('control'),
        follow: await run('follow'),
      };
    },
    expected: {
      inn: {
        refused: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
        opened: false,
        claimed: false,
        holder: null,
        written: 0,
        controls: 0,
        reclaim: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
      },
      out: {
        refused: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
        opened: false,
        claimed: false,
        holder: null,
        written: 0,
        controls: 0,
        reclaim: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
      },
      control: {
        refused: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
        opened: false,
        claimed: false,
        holder: null,
        written: 0,
        controls: 1,
        reclaim: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
      },
      follow: {
        refused: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
        opened: false,
        claimed: false,
        holder: null,
        written: 0,
        controls: 0,
        reclaim: {
          name: 'NotAllowedError',
          message: "USB devices are off in seven's settings",
          errno: 'EACCES',
        },
      },
    },
  },
};
