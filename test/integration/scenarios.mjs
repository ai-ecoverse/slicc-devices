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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (bytes) => new TextDecoder().decode(bytes);

function world({ devices, fake }, { ports = [], choose, active = false, enabled } = {}) {
  const serial = new fake.FakeSerial({ ports, choose });
  const navigator = { serial, userActivation: { isActive: active } };
  const overrides = { navigator };
  if (enabled) overrides.enabled = enabled;
  const page = devices.create(overrides);
  const lines = [];
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(fake.request(kind, options, { progress: (line) => lines.push(line), ...fields }));
  return { page, serial, navigator, lines, ask };
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

export const rows = {
  exports: {
    title: 'exports kinds with their policies, prompts for serial.request only, and ports',
    async run({ devices }) {
      return {
        kinds: devices.kinds,
        same: devices.default.kinds === devices.kinds && devices.create().kinds === devices.kinds,
        prompts: Object.keys(devices.prompts),
        ports: Object.keys(devices.ports).sort(),
        shape: [
          typeof devices.handle,
          typeof devices.create,
          devices.default.handle === devices.handle,
        ],
      };
    },
    expected: {
      kinds: {
        'serial.list': { group: 'dialout', session: false },
        'serial.request': { group: 'dialout', session: false },
        'serial.open': { group: 'dialout', session: false },
        'serial.read': { group: 'dialout', session: false },
        'serial.signals': { group: 'dialout', session: false },
        'serial.close': { group: 'dialout', session: false },
        'serial.write': { session: false },
        'serial.control': { session: false },
        'serial.esptool': { session: false },
      },
      same: true,
      prompts: ['serial.request'],
      ports: ['close', 'closeAll', 'list', 'open', 'watch'],
      shape: ['function', 'function', true],
    },
  },
  list: {
    title: 'lists granted ports in handle order, with their ids, and numbers them once',
    async run(deps) {
      const { fake } = deps;
      const ports = [
        new fake.FakeSerialPort({ usbVendorId: 0x2e8a, usbProductId: 0x0005 }),
        new fake.FakeSerialPort({
          bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb',
        }),
        new fake.FakeSerialPort({}),
      ];
      const { ask, serial } = world(deps, { ports });
      const first = await reply(ask('serial.list'), fake);
      serial.ports.reverse();
      const again = await reply(ask('serial.list'), fake);
      return { first: JSON.parse(first.text), same: first.text === again.text };
    },
    expected: {
      first: [
        { handle: 'serial1', usbVendorId: 0x2e8a, usbProductId: 0x0005, open: false },
        {
          handle: 'serial2',
          bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb',
          open: false,
        },
        { handle: 'serial3', open: false },
      ],
      same: true,
    },
  },
  missing: {
    title:
      'answers ENOTSUP without Web Serial, EACCES when turned off, ENOTSUP for an unknown kind',
    async run({ devices, fake }) {
      const none = devices.create({ navigator: {} });
      const off = devices.create({
        navigator: { serial: new fake.FakeSerial() },
        enabled: () => false,
      });
      return {
        none: await caught(none.handle(fake.request('serial.list')), fake),
        off: await caught(off.handle(fake.request('serial.read', { handle: 'serial1' })), fake),
        unknown: await caught(none.handle(fake.request('serial.nope')), fake),
        prompts: [
          none.prompts['serial.request'](fake.request('serial.request')),
          off.prompts['serial.request'](fake.request('serial.request')),
        ],
      };
    },
    expected: {
      none: {
        name: 'NotSupportedError',
        message: 'this browser has no Web Serial (use Chrome, Edge or Opera on a desktop)',
        errno: 'ENOTSUP',
      },
      off: {
        name: 'NotAllowedError',
        message: "serial ports are off in seven's settings",
        errno: 'EACCES',
      },
      unknown: {
        name: 'NotSupportedError',
        message: 'slicc-devices does not answer serial.nope',
        errno: 'ENOTSUP',
      },
      prompts: [null, null],
    },
  },
  request: {
    title:
      'requests a port: at once when typed and active, after a progress line and a prompt otherwise',
    async run(deps) {
      const { fake } = deps;
      const chosen = new fake.FakeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 });
      let pick = chosen;
      const { page, ask, lines, serial, navigator } = world(deps, {
        ports: [new fake.FakeSerialPort({ usbVendorId: 1, usbProductId: 2 })],
        choose: () => pick,
        active: true,
      });
      const prompt = page.prompts['serial.request'];
      const asked = (stamp) => {
        const said = [];
        return { said, prompt: prompt({ stamp, progress: (line) => said.push(line) }) };
      };
      const typed = asked(typist);
      const filters = [{ usbVendorId: 0x303a }];
      const got = await reply(ask('serial.request', { filters }, { stamp: typist }), fake);
      const agentAsked = asked(agent);
      navigator.userActivation.isActive = false;
      const stale = asked(typist);
      const again = await reply(ask('serial.request', {}, { stamp: agent }), fake);
      pick = undefined;
      const cancelled = await reply(ask('serial.request', {}, { stamp: agent }), fake);
      const bad = await reply(ask('serial.request', { filters: [{ usbProductId: 1 }] }), fake);
      return {
        typed,
        agent: agentAsked,
        stale: stale.said,
        anonymous: asked({ uid: 5 }).prompt.body,
        got: JSON.parse(got.text),
        again: JSON.parse(again.text),
        cancelled,
        bad,
        calls: serial.calls.filter(([name]) => name === 'requestPort'),
        lines,
      };
    },
    expected: {
      typed: { said: [], prompt: null },
      agent: {
        said: ["waiting for a click in seven's tab: choose a serial port"],
        prompt: {
          title: 'Choose a serial port',
          body: "The agent cone wants to use a serial port. Click Choose, then pick it in the browser's list.",
          action: 'Choose…',
          cancel: 'Cancel',
          variant: 'confirmation',
          dismissed: 'no serial port was chosen',
          late: 'nobody clicked within 5 min',
        },
      },
      stale: ["waiting for a click in seven's tab: choose a serial port"],
      anonymous:
        "A program wants to use a serial port. Click Choose, then pick it in the browser's list.",
      got: { handle: 'serial2', usbVendorId: 0x303a, usbProductId: 0x1001, open: false },
      again: { handle: 'serial2', usbVendorId: 0x303a, usbProductId: 0x1001, open: false },
      cancelled: { name: 'NotAllowedError', message: 'no serial port was chosen', errno: 'EACCES' },
      bad: {
        name: 'TypeError',
        message: 'invalid filters: [{"usbProductId":1}]',
        errno: 'EIO',
      },
      calls: [
        ['requestPort', { filters: [{ usbVendorId: 0x303a }] }],
        ['requestPort', { filters: [] }],
        ['requestPort', { filters: [] }],
      ],
      lines: [],
    },
  },
  open: {
    title: 'opens with the given settings, once, and says when another tab or program has it',
    async run(deps) {
      const { fake } = deps;
      const busy = new fake.FakeSerialPort(
        {},
        { opens: { name: 'NetworkError', message: 'Failed to open serial port.' } }
      );
      const port = new fake.FakeSerialPort({ usbVendorId: 1, usbProductId: 2 });
      const { ask, page } = world(deps, { ports: [port, busy] });
      const events = [];
      page.ports.watch((event) => events.push([event.type, event.handle, event.why ?? event.info]));
      const settings = {
        handle: 'serial1',
        baudRate: 115200,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        flowControl: 'hardware',
        bufferSize: 4096,
      };
      const first = await reply(ask('serial.open', settings), fake);
      const twice = await reply(ask('serial.open', settings), fake);
      const elsewhere = await reply(
        ask('serial.open', { handle: 'serial2', baudRate: 9600 }),
        fake
      );
      const bad = await reply(ask('serial.open', { handle: 'serial2', baudRate: 0 }), fake);
      const parity = await reply(
        ask('serial.open', { handle: 'serial2', baudRate: 9600, parity: 'mark' }),
        fake
      );
      const unknown = await reply(ask('serial.open', { handle: 'serial9', baudRate: 9600 }), fake);
      const listed = JSON.parse((await reply(ask('serial.list'), fake)).text);
      return {
        first,
        twice,
        elsewhere,
        bad,
        parity,
        unknown,
        options: port.options,
        listed: listed.map(({ handle, open }) => [handle, open]),
        open: page.ports.open().map(({ handle }) => handle),
        events,
      };
    },
    expected: {
      first: { text: '' },
      twice: { name: 'InvalidStateError', message: 'serial1 is already open', errno: 'EIO' },
      elsewhere: {
        name: 'InvalidStateError',
        message: 'serial2 is open in another tab or program',
        errno: 'EIO',
      },
      bad: { name: 'TypeError', message: 'invalid baudRate: 0', errno: 'EIO' },
      parity: { name: 'TypeError', message: 'invalid parity: "mark"', errno: 'EIO' },
      unknown: {
        name: 'NotFoundError',
        message: "unknown serial handle 'serial9'",
        errno: 'ENOENT',
      },
      options: {
        baudRate: 115200,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        flowControl: 'hardware',
        bufferSize: 4096,
      },
      listed: [
        ['serial1', true],
        ['serial2', false],
      ],
      open: ['serial1'],
      events: [
        ['open', 'serial1', { handle: 'serial1', usbVendorId: 1, usbProductId: 2, open: true }],
      ],
    },
  },
  reads: {
    title:
      'reads with bytes, until (across chunks) and a silence timeout, keeping the rest buffered',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const before = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      port.feed('hello world');
      await sleep(20);
      const bytes = await reply(ask('serial.read', { handle: 'serial1', bytes: 5 }), fake);
      const rest = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      const until = ask('serial.read', { handle: 'serial1', until: '0d0a', timeout: 0 });
      port.feed('ok\r');
      await sleep(20);
      port.feed('\nnext');
      const line = await reply(until, fake);
      const timed = ask('serial.read', { handle: 'serial1', timeout: 80 });
      const started = Date.now();
      for (const piece of ['a', 'b', 'c']) {
        await sleep(30);
        port.feed(piece);
      }
      const slow = await reply(timed, fake);
      return {
        before,
        bytes,
        rest,
        line,
        slow,
        lasted: Date.now() - started >= 160,
        bad: [
          await reply(ask('serial.read', { handle: 'serial1', until: 'abc' }), fake),
          await reply(ask('serial.read', { handle: 'serial1', follow: true, bytes: 3 }), fake),
          await reply(ask('serial.read', { handle: 'serial1', timeout: -1 }), fake),
        ],
      };
    },
    expected: {
      before: { text: '' },
      bytes: { text: 'hello' },
      rest: { text: ' world' },
      line: { text: 'ok\r\n' },
      slow: { text: 'nextabc' },
      lasted: true,
      bad: [
        { name: 'TypeError', message: 'invalid until: "abc"', errno: 'EIO' },
        { name: 'TypeError', message: 'follow takes no bytes, until or timeout', errno: 'EIO' },
        { name: 'TypeError', message: 'invalid timeout: -1', errno: 'EIO' },
      ],
    },
  },
  follow: {
    title:
      'follows until the request ends, refuses a second read meanwhile, and ends at EOF on close',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const controller = new AbortController();
      const stream = await ask(
        'serial.read',
        { handle: 'serial1', follow: true },
        { signal: controller.signal }
      );
      const reader = stream.getReader();
      const got = [];
      port.feed('one');
      got.push(text((await reader.read()).value));
      const second = await caught(ask('serial.read', { handle: 'serial1' }), fake);
      await sleep(1100);
      port.feed('two');
      got.push(text((await reader.read()).value));
      controller.abort('interrupted');
      const ended = await reader.read();
      const after = await reply(ask('serial.read', { handle: 'serial1', timeout: 20 }), fake);
      const closing = await ask('serial.read', { handle: 'serial1', follow: true });
      const tail = fake.drain(closing);
      port.feed('last');
      await sleep(20);
      await ask('serial.close', { handle: 'serial1' });
      return { got, second, ended: ended.done, after, tail: await tail };
    },
    expected: {
      got: ['one', 'two'],
      second: {
        name: 'InvalidStateError',
        message: 'another read is in progress on serial1',
        errno: 'EIO',
      },
      ended: true,
      after: { text: '' },
      tail: 'last',
    },
  },
  writes: {
    title:
      'takes the whole body (at most 4 MiB) first, then writes it through writer.ready, and replies with the count',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({}, { sink: 2 });
      const { ask } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      let pulled = 0;
      let early = 0;
      const chunk = new Uint8Array(1024).fill(0x41);
      let left = 64;
      const body = new ReadableStream(
        {
          pull(controller) {
            early = Math.max(early, port.writtenBytes);
            if (!left--) return controller.close();
            pulled += chunk.length;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 }
      );
      const count = await reply(ask('serial.write', { handle: 'serial1' }, { body }), fake);
      const empty = await reply(ask('serial.write', { handle: 'serial1' }), fake);
      return {
        count,
        pulled,
        written: port.writtenBytes,
        early,
        paced: port.ahead <= 2,
        empty,
      };
    },
    expected: {
      count: { text: '65536' },
      pulled: 65536,
      written: 65536,
      early: 0,
      paced: true,
      empty: { text: '0' },
    },
  },
  cap: {
    title: 'leaves nothing on the device when a write streams past 4 MiB',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const sizes = [3 * 1024 * 1024, 2 * 1024 * 1024];
      const body = new ReadableStream(
        {
          pull(controller) {
            const size = sizes.shift();
            if (size === undefined) return controller.close();
            controller.enqueue(new Uint8Array(size));
          },
        },
        { highWaterMark: 0 }
      );
      const write = await reply(ask('serial.write', { handle: 'serial1' }, { body }), fake);
      await sleep(20);
      return {
        write,
        written: port.writtenBytes,
        after: await reply(
          ask('serial.write', { handle: 'serial1' }, { body: fake.bytes('ok') }),
          fake
        ),
      };
    },
    expected: {
      write: {
        name: 'QuotaExceededError',
        message: 'a serial write is at most 4 MiB',
        errno: 'EIO',
      },
      written: 0,
      after: { text: '2' },
    },
  },
  dropping: {
    title: 'says what it drops while a follow read is attached, as it drops it',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask, lines } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const controller = new AbortController();
      const stream = await ask(
        'serial.read',
        { handle: 'serial1', follow: true },
        { signal: controller.signal }
      );
      const block = new Uint8Array(65536);
      for (let i = 0; i < 17; i++) port.feed(block.fill(i));
      await sleep(50);
      const first = [...lines];
      port.feed('end');
      await sleep(350);
      const reader = stream.getReader();
      let size = 0;
      let head = null;
      let tail = '';
      while (size < 1024 * 1024) {
        const { value } = await reader.read();
        head ??= value[0];
        size += value.length;
        tail = text(value.subarray(Math.max(0, value.length - 3)));
      }
      controller.abort('closed');
      return { first, lines, size, head, tail };
    },
    expected: {
      first: ['serial1: 65536 bytes dropped (nobody read in time)'],
      lines: [
        'serial1: 65536 bytes dropped (nobody read in time)',
        'serial1: 3 bytes dropped (nobody read in time)',
      ],
      size: 1048576,
      head: 1,
      tail: 'end',
    },
  },
  limits: {
    title: 'refuses a read or a write over 4 MiB',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const big = 4 * 1024 * 1024 + 1;
      const read = await reply(ask('serial.read', { handle: 'serial1', bytes: big }), fake);
      const write = await reply(
        ask('serial.write', { handle: 'serial1' }, { body: fake.bytes(new Uint8Array(big)) }),
        fake
      );
      return { read, write, written: port.writtenBytes };
    },
    expected: {
      read: {
        name: 'QuotaExceededError',
        message: 'a serial read is at most 4 MiB without follow',
        errno: 'EIO',
      },
      write: {
        name: 'QuotaExceededError',
        message: 'a serial write is at most 4 MiB',
        errno: 'EIO',
      },
      written: 0,
    },
  },
  overflow: {
    title: 'keeps the newest 1 MiB and says how much it dropped before the next read',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask, lines } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const block = new Uint8Array(65536);
      for (let i = 0; i < 17; i++) port.feed(block.fill(i));
      port.feed('end');
      await sleep(50);
      const stream = await ask('serial.read', { handle: 'serial1', timeout: 30 });
      const bytes = await fake.collect(stream);
      return {
        lines,
        size: bytes.length,
        first: bytes[0],
        tail: text(bytes.subarray(bytes.length - 3)),
      };
    },
    expected: {
      lines: ['serial1: 65539 bytes dropped (nobody read in time)'],
      size: 1048576,
      first: 1,
      tail: 'end',
    },
  },
  signals: {
    title: 'gets the input signals and sets the output ones',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const { ask } = world(deps, { ports: [port] });
      const closed = await reply(ask('serial.signals', { handle: 'serial1' }), fake);
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      port.inputs.ringIndicator = true;
      const got = await reply(ask('serial.signals', { handle: 'serial1' }), fake);
      const set = await reply(
        ask('serial.control', { handle: 'serial1', dataTerminalReady: false, requestToSend: true }),
        fake
      );
      const none = await reply(ask('serial.control', { handle: 'serial1' }), fake);
      const bad = await reply(ask('serial.control', { handle: 'serial1', break: 'on' }), fake);
      return { closed, got: JSON.parse(got.text), set, none, bad, outputs: port.outputs };
    },
    expected: {
      closed: {
        name: 'InvalidStateError',
        message: 'serial1 is not open (serial open serial1 --baud N)',
        errno: 'EIO',
      },
      got: { clearToSend: true, dataCarrierDetect: false, dataSetReady: true, ringIndicator: true },
      set: { text: '' },
      none: {
        name: 'TypeError',
        message: 'serial.control needs dataTerminalReady, requestToSend or break',
        errno: 'EIO',
      },
      bad: { name: 'TypeError', message: 'invalid break: "on"', errno: 'EIO' },
      outputs: [{ dataTerminalReady: false, requestToSend: true }],
    },
  },
  close: {
    title: 'closes, closing a closed port succeeds, and a port closed in seven fails later writes',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({});
      const other = new fake.FakeSerialPort({});
      const { ask, page } = world(deps, { ports: [port, other] });
      const events = [];
      page.ports.watch((event) => events.push([event.type, event.handle, event.why ?? null]));
      const never = await reply(ask('serial.close', { handle: 'serial1' }), fake);
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      await ask('serial.close', { handle: 'serial1' });
      const again = await reply(ask('serial.close', { handle: 'serial1' }), fake);
      const write = await reply(
        ask('serial.write', { handle: 'serial1' }, { body: fake.bytes('x') }),
        fake
      );
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      await ask('serial.open', { handle: 'serial2', baudRate: 9600 });
      const follow = fake.drain(await ask('serial.read', { handle: 'serial1', follow: true }));
      port.feed('bye');
      await sleep(20);
      await page.ports.close('serial9');
      await page.ports.closeAll();
      const late = await reply(
        ask('serial.write', { handle: 'serial1' }, { body: fake.bytes('x') }),
        fake
      );
      const reopened = await reply(ask('serial.open', { handle: 'serial1', baudRate: 9600 }), fake);
      await page.ports.close('serial1');
      return {
        never,
        again,
        write,
        follow: await follow,
        late,
        reopened,
        open: page.ports.open(),
        events,
        closes: port.calls.filter(([name]) => name === 'close').length,
      };
    },
    expected: {
      never: { text: '' },
      again: { text: '' },
      write: {
        name: 'InvalidStateError',
        message: 'serial1 is not open (serial open serial1 --baud N)',
        errno: 'EIO',
      },
      follow: 'bye',
      late: { name: 'InvalidStateError', message: 'serial1 was closed in seven', errno: 'EIO' },
      reopened: { text: '' },
      open: [],
      events: [
        ['open', 'serial1', null],
        ['close', 'serial1', 'closed'],
        ['open', 'serial1', null],
        ['open', 'serial2', null],
        ['close', 'serial1', 'seven'],
        ['close', 'serial2', 'seven'],
        ['open', 'serial1', null],
        ['close', 'serial1', 'seven'],
      ],
      closes: 3,
    },
  },
  boards: {
    title:
      'gives a second identical board picked in the chooser its own handle, and guesses no handle between two gone boards',
    async run(deps) {
      const { fake } = deps;
      const ids = { usbVendorId: 0x2e8a, usbProductId: 0x0005 };
      const a = new fake.FakeSerialPort(ids);
      const b = new fake.FakeSerialPort(ids);
      let pick = b;
      const { ask, serial } = world(deps, { ports: [a], choose: () => pick });
      await ask('serial.list');
      a.unplug();
      const chosen = JSON.parse((await reply(ask('serial.request'), fake)).text);
      const first = await reply(ask('serial.open', { handle: 'serial1', baudRate: 9600 }), fake);
      const back = serial.plug(new fake.FakeSerialPort(ids));
      const listed = JSON.parse((await reply(ask('serial.list'), fake)).text);
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      await reply(ask('serial.write', { handle: 'serial1' }, { body: fake.bytes('A') }), fake);
      await ask('serial.close', { handle: 'serial1' });
      back.unplug();
      b.unplug();
      pick = undefined;
      const third = serial.plug(new fake.FakeSerialPort(ids));
      const after = JSON.parse((await reply(ask('serial.list'), fake)).text);
      return {
        chosen,
        first,
        listed: listed.map(({ handle }) => handle),
        wrote: [back.text(), b.text()],
        after: after.map(({ handle }) => handle),
        third: third.calls.length,
      };
    },
    expected: {
      chosen: { handle: 'serial2', usbVendorId: 0x2e8a, usbProductId: 0x0005, open: false },
      first: { name: 'InvalidStateError', message: 'serial1 was unplugged', errno: 'EIO' },
      listed: ['serial1', 'serial2'],
      wrote: ['A', ''],
      after: ['serial3'],
      third: 0,
    },
  },
  unplug: {
    title:
      'ends reads with EIO when an open port is unplugged, and gives a replugged port its handle back',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 });
      const stranger = new fake.FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
      const { ask, serial, page } = world(deps, { ports: [port, stranger] });
      await ask('serial.list');
      await ask('serial.open', { handle: 'serial1', baudRate: 115200 });
      const follow = reply(ask('serial.read', { handle: 'serial1', follow: true }), fake);
      port.feed('boot');
      await sleep(20);
      port.unplug();
      const ended = await follow;
      const write = await reply(
        ask('serial.write', { handle: 'serial1' }, { body: fake.bytes('x') }),
        fake
      );
      const gone = JSON.parse((await reply(ask('serial.list'), fake)).text);
      const back = serial.plug(
        new fake.FakeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 })
      );
      const other = serial.plug(
        new fake.FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x6001 })
      );
      const listed = JSON.parse((await reply(ask('serial.list'), fake)).text);
      await ask('serial.open', { handle: 'serial1', baudRate: 115200 });
      back.feed('again');
      const read = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      await page.ports.closeAll();
      return { ended, write, gone, listed, read, other: other.calls.length };
    },
    expected: {
      ended: { name: 'InvalidStateError', message: 'serial1 was unplugged', errno: 'EIO' },
      write: { name: 'InvalidStateError', message: 'serial1 was unplugged', errno: 'EIO' },
      gone: [{ handle: 'serial2', usbVendorId: 0x1a86, usbProductId: 0x7523, open: false }],
      listed: [
        { handle: 'serial1', usbVendorId: 0x303a, usbProductId: 0x1001, open: false },
        { handle: 'serial2', usbVendorId: 0x1a86, usbProductId: 0x7523, open: false },
        { handle: 'serial3', usbVendorId: 0x0403, usbProductId: 0x6001, open: false },
      ],
      read: { text: 'again' },
      other: 0,
    },
  },
  console: {
    title: 'serves a follow read and writes at the same time, as console does',
    async run(deps) {
      const { fake } = deps;
      const port = new fake.FakeSerialPort({}, { echo: true });
      const { ask, page } = world(deps, { ports: [port] });
      await ask('serial.open', { handle: 'serial1', baudRate: 115200 });
      const controller = new AbortController();
      const stream = await ask(
        'serial.read',
        { handle: 'serial1', follow: true },
        { signal: controller.signal }
      );
      const reader = stream.getReader();
      const counts = [];
      for (const key of ['l', 's', '\r']) {
        counts.push(
          await fake.drain(
            await ask('serial.write', { handle: 'serial1' }, { body: fake.bytes(key) })
          )
        );
      }
      let seen = '';
      while (seen.length < 3) seen += text((await reader.read()).value);
      controller.abort('closed');
      await page.ports.closeAll();
      return { counts, seen, written: port.text() };
    },
    expected: { counts: ['1', '1', '1'], seen: 'ls\r', written: 'ls\r' },
  },
  offOpen: {
    title:
      'closeAll during a pending port.open fails it with EACCES and leaves no open port or buffered bytes',
    async run(deps) {
      const { fake } = deps;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let on = true;
      const port = new fake.FakeSerialPort({}, { gate, boot: 'sneaky' });
      const { ask, page } = world(deps, { ports: [port], enabled: () => on });
      await ask('serial.list');
      const pending = reply(ask('serial.open', { handle: 'serial1', baudRate: 115200 }), fake);
      await sleep(20);
      on = false;
      await page.ports.closeAll();
      release();
      const opened = await pending;
      on = true;
      const listed = JSON.parse((await reply(ask('serial.list'), fake)).text);
      const read = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      return {
        opened,
        open: page.ports.open(),
        listed,
        read,
        closed: port.calls.filter(([name]) => name === 'close').length,
      };
    },
    expected: {
      opened: {
        name: 'NotAllowedError',
        message: "serial ports are off in seven's settings",
        errno: 'EACCES',
      },
      open: [],
      listed: [{ handle: 'serial1', open: false }],
      read: {
        name: 'InvalidStateError',
        message: 'serial1 is not open (serial open serial1 --baud N)',
        errno: 'EIO',
      },
      closed: 1,
    },
  },
  offRequest: {
    title:
      'closeAll during a pending requestPort fails it; the browser grant lists closed once the switch is on again',
    async run(deps) {
      const { fake } = deps;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let on = true;
      const chosen = new fake.FakeSerialPort({ usbVendorId: 0x1234, usbProductId: 0x5678 });
      const { ask, page } = world(deps, {
        ports: [],
        choose: async () => {
          await gate;
          return chosen;
        },
        enabled: () => on,
      });
      const pending = reply(ask('serial.request'), fake);
      await sleep(20);
      on = false;
      await page.ports.closeAll();
      release();
      const requested = await pending;
      const whileOff = page.ports.open();
      on = true;
      const listed = JSON.parse((await reply(ask('serial.list'), fake)).text);
      return { requested, whileOff, listed, open: page.ports.open() };
    },
    expected: {
      requested: {
        name: 'NotAllowedError',
        message: "serial ports are off in seven's settings",
        errno: 'EACCES',
      },
      whileOff: [],
      listed: [{ handle: 'serial1', usbVendorId: 0x1234, usbProductId: 0x5678, open: false }],
      open: [],
    },
  },
  offAfter: {
    title: 'closeAll after open returned closes the port; a later open starts with an empty buffer',
    async run(deps) {
      const { fake } = deps;
      let on = true;
      const port = new fake.FakeSerialPort({});
      const { ask, page } = world(deps, { ports: [port], enabled: () => on });
      await ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      port.feed('kept');
      await sleep(20);
      on = false;
      await page.ports.closeAll();
      on = true;
      const late = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      const reopen = await reply(ask('serial.open', { handle: 'serial1', baudRate: 9600 }), fake);
      port.feed('fresh');
      const read = await reply(ask('serial.read', { handle: 'serial1', timeout: 30 }), fake);
      return { late, reopen, read, open: page.ports.open().map((entry) => entry.handle) };
    },
    expected: {
      late: {
        name: 'InvalidStateError',
        message: 'serial1 was closed in seven',
        errno: 'EIO',
      },
      reopen: { text: '' },
      read: { text: 'fresh' },
      open: ['serial1'],
    },
  },
};
