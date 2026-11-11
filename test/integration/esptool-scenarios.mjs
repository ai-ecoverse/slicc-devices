const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOARD = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
const HINT = '(press RESET, or esptool --port serial1 run)';

function bench({ devices, fake, esp }, { chip = 'ESP32', silent = false, enabled, esptool } = {}) {
  const device = new esp.FakeEsp({ chip, silent });
  const port = new fake.FakeSerialPort(BOARD, { device });
  const serial = new fake.FakeSerial({ ports: [port] });
  const overrides = { navigator: { serial } };
  if (enabled) overrides.enabled = enabled;
  if (esptool) overrides.esptool = esptool;
  const page = devices.create(overrides);
  const lines = [];
  const events = [];
  page.ports.watch((event) =>
    events.push(event.type === 'open' ? ['open', event.handle] : ['close', event.handle, event.why])
  );
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(
      fake.request(kind, options, {
        progress: (line) => lines.push([Date.now(), line]),
        ...fields,
      })
    );
  const tool = (options, fields) =>
    ask('serial.esptool', { handle: 'serial1', ...options }, fields);
  return { page, serial, port, device, lines, events, ask, tool };
}

async function reply(promise, fake) {
  try {
    return { text: await fake.drain(await promise) };
  } catch (error) {
    return { name: error.name, message: error.message, errno: fake.errno(error) };
  }
}

async function until(test) {
  for (let i = 0; i < 1000 && !test(); i++) await sleep(10);
  return test();
}

function image(length, seed) {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function joined(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const blank = (bytes) => bytes.every((value) => value === 0xff);

async function midWrite(deps, stop) {
  const flipped = { off: false };
  const b = bench(deps, { enabled: () => !flipped.off });
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  b.device.pause = (op) => (op === deps.esp.OP.deflData ? gate : null);
  const data = image(5000, 3);
  const writing = reply(
    b.tool(
      { op: 'write_flash', segments: [{ address: 0x10000, size: data.length }] },
      { body: deps.fake.bytes(data) }
    ),
    deps.fake
  );
  const reached = await until(() => b.device.seen.includes(deps.esp.OP.deflData));
  await stop(b, flipped);
  const result = await writing;
  open();
  return {
    reached,
    result,
    events: b.events.slice(),
    flash: blank(b.device.flash.subarray(0x10000, 0x10000 + data.length)),
    open: b.page.ports.open(),
    closed: b.port.readable === null,
    after: await reply(b.tool({ op: 'read_mac' }), deps.fake),
  };
}

const LINES = [
  'Serial port WebSerial VendorID 0x10c4 ProductID 0xea60',
  'Connecting...',
  'Detecting chip type...',
  'ESP32',
  'Chip Revision: 3',
  'Chip is ESP32-D0WDQ6-V3 (revision 3)',
  'Features: Wi-Fi, BT, Dual Core, Coding Scheme None',
  'Crystal is 40MHz',
  'MAC: 24:0a:c4:12:34:56',
  'Uploading stub...',
  'Running stub...',
  'Stub running...',
  'Flash ID: 164020',
  'Hard resetting via RTS pin...',
];

export const rows = {
  chip: {
    title:
      'chip_id detects the ESP32 through the stub, prints six lines, shows the port open, and coalesces progress without delaying the reply',
    async run(deps) {
      const b = bench(deps);
      const result = await reply(b.tool({ op: 'chip_id' }), deps.fake);
      const answered = Date.now();
      const lines = b.lines.map(([, line]) => line);
      const gaps = b.lines.slice(1).map(([at], i) => at - b.lines[i][0]);
      const order = lines.map((line) => LINES.indexOf(line));
      return {
        result,
        first: lines[0],
        last: lines.at(-1),
        known: order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
        paced: gaps.every((gap) => gap >= 250),
        prompt: answered - b.device.quiet < 400,
        events: b.events,
        closed: b.port.readable === null,
        reset: b.device.resets > 0,
        list: await reply(b.ask('serial.list'), deps.fake),
      };
    },
    expected: {
      result: {
        text: 'Chip type: ESP32\nChip description: ESP32-D0WDQ6-V3 (revision 3)\nFeatures: Wi-Fi, BT, Dual Core, Coding Scheme None\nCrystal: 40MHz\nMAC: 24:0a:c4:12:34:56\n',
      },
      first: 'Serial port WebSerial VendorID 0x10c4 ProductID 0xea60',
      last: 'Hard resetting via RTS pin...',
      known: true,
      paced: true,
      prompt: true,
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
      closed: true,
      reset: true,
      list: {
        text: '[{"handle":"serial1","usbVendorId":4292,"usbProductId":60000,"open":false}]',
      },
    },
  },
  ids: {
    title: 'read_mac, flash_id and read_reg answer with six’s lines',
    async run(deps) {
      const b = bench(deps);
      return {
        mac: await reply(b.tool({ op: 'read_mac', chip: 'esp32' }), deps.fake),
        flash: await reply(b.tool({ op: 'flash_id' }), deps.fake),
        reg: await reply(b.tool({ op: 'read_reg', address: 0x3ff5a004 }), deps.fake),
      };
    },
    expected: {
      mac: { text: 'MAC: 24:0a:c4:12:34:56\n' },
      flash: { text: 'Manufacturer: 0x20\nDevice: 0x4016\nDetected flash size: 4MB\n' },
      reg: { text: '0x3ff5a004 = 0xc4123456\n' },
    },
  },
  flash: {
    title:
      'write_flash writes two segments, read_flash streams them back identical, and erase_region erases',
    async run(deps) {
      const b = bench(deps);
      const first = image(5000, 1);
      const second = image(3000, 2);
      const written = await reply(
        b.tool(
          {
            op: 'write_flash',
            segments: [
              { address: 0x1000, size: first.length },
              { address: 0x10000, size: second.length },
            ],
          },
          { body: deps.fake.bytes(joined(first, second)) }
        ),
        deps.fake
      );
      const back = async (address, size) =>
        deps.fake.collect(
          await b.tool({ op: 'read_flash', address, size }, { progress: () => {} })
        );
      const one = await back(0x1000, first.length);
      const two = await back(0x10000, second.length);
      const erased = await reply(
        b.tool({ op: 'erase_region', address: 0x1000, size: 0x2000 }),
        deps.fake
      );
      return {
        written,
        one: same(one, first),
        two: same(two, second),
        gap: blank(b.device.flash.subarray(0x1000 + first.length, 0x10000)),
        erased,
        wiped: blank(b.device.flash.subarray(0x1000, 0x3000)),
        kept: same(b.device.flash.subarray(0x10000, 0x10000 + second.length), second),
        events: b.events.length,
      };
    },
    expected: {
      written: { text: 'flash written\n' },
      one: true,
      two: true,
      gap: true,
      erased: { text: 'region erased\n' },
      wiped: true,
      kept: true,
      events: 8,
    },
  },
  erase: {
    title: 'erase_flash clears what the flash held',
    async run(deps) {
      const b = bench(deps);
      b.device.flash.set(image(8192, 4), 0x1000);
      b.device.flash.set(image(4096, 5), 0x3f0000);
      const result = await reply(b.tool({ op: 'erase_flash' }), deps.fake);
      return {
        result,
        blank: blank(b.device.flash),
        events: b.events,
        booted: b.device.booted,
      };
    },
    expected: {
      result: { text: 'flash erased\n' },
      blank: true,
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
      booted: 1,
    },
  },
  eraseAll: {
    title: 'write_flash with erase clears everything outside the new image and writes it intact',
    async run(deps) {
      const b = bench(deps);
      b.device.flash.set(image(8192, 6), 0x1000);
      b.device.flash.set(image(4096, 7), 0x200000);
      const data = image(6000, 8);
      const result = await reply(
        b.tool(
          { op: 'write_flash', segments: [{ address: 0x10000, size: data.length }], erase: true },
          { body: deps.fake.bytes(data) }
        ),
        deps.fake
      );
      const { flash } = b.device;
      return {
        result,
        erased: b.device.seen.includes(deps.esp.OP.eraseFlash),
        image: same(flash.subarray(0x10000, 0x10000 + data.length), data),
        before: blank(flash.subarray(0, 0x10000)),
        after: blank(flash.subarray(0x10000 + data.length)),
      };
    },
    expected: {
      result: { text: 'flash written\n' },
      erased: true,
      image: true,
      before: true,
      after: true,
    },
  },
  run: {
    title: 'run resets the chip into its app and closes the port',
    async run(deps) {
      const b = bench(deps);
      const result = await reply(b.tool({ op: 'run' }), deps.fake);
      return {
        result,
        booted: b.device.booted,
        mode: b.device.mode,
        events: b.events,
        closed: b.port.readable === null,
        open: b.page.ports.open(),
      };
    },
    expected: {
      result: { text: 'running app\n' },
      booted: 1,
      mode: 'app',
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
      closed: true,
      open: [],
    },
  },
  closeLoad: {
    title:
      'Close while esptool-js is still loading cancels the run: nothing reaches the chip and the port stays closed',
    async run(deps) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const b = bench(deps, {
        esptool: async () => {
          await gate;
          return deps.tool;
        },
      });
      const writing = reply(
        b.tool(
          { op: 'write_flash', segments: [{ address: 0x10000, size: 4 }] },
          { body: deps.fake.bytes(new Uint8Array(4)) }
        ),
        deps.fake
      );
      await sleep(20);
      const busy = await reply(
        b.ask('serial.open', { handle: 'serial1', baudRate: 9600 }),
        deps.fake
      );
      const closing = b.page.ports.close('serial1');
      release();
      await closing;
      return {
        busy,
        result: await writing,
        seen: b.device.seen.length,
        opens: b.port.calls.length,
        events: b.events.slice(),
        open: b.page.ports.open(),
        after: await reply(b.tool({ op: 'read_mac' }), deps.fake),
      };
    },
    expected: {
      busy: { name: 'InvalidStateError', message: 'serial1 is in use by esptool', errno: 'EIO' },
      result: { name: 'InvalidStateError', message: 'serial1 was closed in seven', errno: 'EIO' },
      seen: 0,
      opens: 0,
      events: [],
      open: [],
      after: { text: 'MAC: 24:0a:c4:12:34:56\n' },
    },
  },
  closeBody: {
    title:
      'Close while the firmware body still streams cancels the run: nothing reaches the chip and the port stays closed',
    async run(deps) {
      const b = bench(deps);
      let pulled = false;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2));
        },
        pull() {
          pulled = true;
          return new Promise(() => {});
        },
      });
      const writing = reply(
        b.tool({ op: 'write_flash', segments: [{ address: 0x10000, size: 4 }] }, { body }),
        deps.fake
      );
      const reached = await until(() => pulled);
      await b.page.ports.close('serial1');
      return {
        reached,
        result: await writing,
        seen: b.device.seen.length,
        opens: b.port.calls.length,
        events: b.events,
        closed: b.port.readable === null,
      };
    },
    expected: {
      reached: true,
      result: { name: 'InvalidStateError', message: 'serial1 was closed in seven', errno: 'EIO' },
      seen: 0,
      opens: 0,
      events: [],
      closed: true,
    },
  },
  pastEnd: {
    title:
      'writes, reads and erases past the end of the detected flash are refused before anything is erased or written',
    async run(deps) {
      const b = bench(deps);
      const kept = image(4096, 9);
      b.device.flash.set(kept, 0x3f0000);
      const write = await reply(
        b.tool(
          { op: 'write_flash', segments: [{ address: 0x3ff000, size: 0x2000 }], erase: true },
          { body: deps.fake.bytes(image(0x2000, 10)) }
        ),
        deps.fake
      );
      const read = await reply(
        b.tool({ op: 'read_flash', address: 0x400000, size: 16 }),
        deps.fake
      );
      const erase = await reply(
        b.tool({ op: 'erase_region', address: 0x3ff000, size: 0x2000 }),
        deps.fake
      );
      const { OP } = deps.esp;
      return {
        write,
        read,
        erase,
        kept: same(b.device.flash.subarray(0x3f0000, 0x3f0000 + kept.length), kept),
        touched: [OP.eraseFlash, OP.eraseRegion, OP.deflBegin, OP.flashBegin, OP.readFlash].some(
          (op) => b.device.seen.includes(op)
        ),
      };
    },
    expected: {
      write: {
        name: 'OperationError',
        message: '0x3ff000+0x2000 is past the end of the 4MB flash',
        errno: 'EIO',
      },
      read: {
        name: 'OperationError',
        message: '0x400000+0x10 is past the end of the 4MB flash',
        errno: 'EIO',
      },
      erase: {
        name: 'OperationError',
        message: '0x3ff000+0x2000 is past the end of the 4MB flash',
        errno: 'EIO',
      },
      kept: true,
      touched: false,
    },
  },
  mismatch: {
    title: 'a named chip that is not the one found fails before any operation runs',
    async run(deps) {
      const b = bench(deps, { chip: 'ESP8266' });
      const result = await reply(b.tool({ op: 'erase_flash', chip: 'esp32' }), deps.fake);
      return {
        result,
        stub: b.device.seen.includes(deps.esp.OP.memBegin),
        erased: b.device.seen.includes(deps.esp.OP.eraseFlash),
        events: b.events,
      };
    },
    expected: {
      result: {
        name: 'OperationError',
        message: 'this chip is ESP8266, not esp32 (wrong --chip?)',
        errno: 'EIO',
      },
      stub: false,
      erased: false,
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
    },
  },
  silent: {
    title: 'a chip that never answers gives the BOOT and RESET hint',
    async run(deps) {
      const b = bench(deps, { silent: true });
      return {
        result: await reply(b.tool({ op: 'chip_id' }), deps.fake),
        events: b.events,
        closed: b.port.readable === null,
      };
    },
    expected: {
      result: {
        name: 'OperationError',
        message: 'no ESP chip answered on serial1 (hold BOOT and press RESET, then try again)',
        errno: 'EIO',
      },
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
      closed: true,
    },
  },
  close: {
    title: 'Close in seven aborts a write and says the chip stays in its bootloader',
    async run(deps) {
      return midWrite(deps, (b) => b.page.ports.close('serial1'));
    },
    expected: {
      reached: true,
      result: {
        name: 'InvalidStateError',
        message: `serial1 was closed in seven; the chip stays in its bootloader ${HINT}`,
        errno: 'EIO',
      },
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'seven'],
      ],
      flash: true,
      open: [],
      closed: true,
      after: { text: 'MAC: 24:0a:c4:12:34:56\n' },
    },
  },
  off: {
    title: 'the Serial ports switch aborts a write, and later requests are refused',
    async run(deps) {
      return midWrite(deps, async (b, flipped) => {
        flipped.off = true;
        await b.page.ports.closeAll();
      });
    },
    expected: {
      reached: true,
      result: {
        name: 'InvalidStateError',
        message: `serial1 was closed in seven; the chip stays in its bootloader ${HINT}`,
        errno: 'EIO',
      },
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'seven'],
      ],
      flash: true,
      open: [],
      closed: true,
      after: {
        name: 'NotAllowedError',
        message: "serial ports are off in seven's settings",
        errno: 'EACCES',
      },
    },
  },
  limits: {
    title:
      'overlapping, out-of-order and oversized segments, a short body and an unaligned erase fail before the port opens',
    async run(deps) {
      const b = bench(deps);
      const ask = (options, body) =>
        reply(b.tool(options, body ? { body: deps.fake.bytes(body) } : {}), deps.fake);
      const write = (segments, body) => ask({ op: 'write_flash', segments }, body);
      return {
        overlap: await write([
          { address: 0x1000, size: 0x2000 },
          { address: 0x2000, size: 0x10 },
        ]),
        order: await write([
          { address: 0x8000, size: 0x10 },
          { address: 0x1000, size: 0x10 },
        ]),
        big: await write([
          { address: 0, size: 0x800000 },
          { address: 0x800000, size: 0x800001 },
        ]),
        short: await write([{ address: 0x1000, size: 4 }], new Uint8Array(3)),
        long: await write([{ address: 0x1000, size: 4 }], new Uint8Array(5)),
        unaligned: await ask({ op: 'erase_region', address: 0x1001, size: 0x1000 }),
        op: await ask({ op: 'reboot' }),
        handle: await reply(b.ask('serial.esptool', { handle: 'serial9', op: 'run' }), deps.fake),
        touched: b.port.calls.length + b.events.length,
      };
    },
    expected: {
      overlap: {
        name: 'TypeError',
        message: 'write_flash segments overlap or are out of order: 0x2000 starts before 0x3000',
        errno: 'EIO',
      },
      order: {
        name: 'TypeError',
        message: 'write_flash segments overlap or are out of order: 0x1000 starts before 0x8010',
        errno: 'EIO',
      },
      big: { name: 'TypeError', message: 'write_flash takes at most 16 MiB', errno: 'EIO' },
      short: {
        name: 'TypeError',
        message: 'the body has 3 bytes; the segments need 4',
        errno: 'EIO',
      },
      long: {
        name: 'TypeError',
        message: "the body is longer than the segments' 4 bytes",
        errno: 'EIO',
      },
      unaligned: {
        name: 'TypeError',
        message: 'erase_region needs a 4 KiB aligned address and size',
        errno: 'EIO',
      },
      op: { name: 'TypeError', message: 'invalid op: "reboot"', errno: 'EIO' },
      handle: {
        name: 'NotFoundError',
        message: "unknown serial handle 'serial9'",
        errno: 'ENOENT',
      },
      touched: 0,
    },
  },
  busy: {
    title:
      'takes over a port serial holds open, and refuses serial requests and a second esptool meanwhile',
    async run(deps) {
      const b = bench(deps);
      await b.ask('serial.open', { handle: 'serial1', baudRate: 9600 });
      const running = reply(b.tool({ op: 'read_mac' }), deps.fake);
      await until(() => b.device.seen.length > 0);
      const result = {
        read: await reply(b.ask('serial.read', { handle: 'serial1', timeout: 10 }), deps.fake),
        again: await reply(b.tool({ op: 'read_mac' }), deps.fake),
        open: b.page.ports.open().map(({ handle }) => handle),
      };
      return {
        ...result,
        mac: await running,
        events: b.events,
        settings: b.port.calls
          .filter(([name]) => name === 'open')
          .map(([, options]) => options.baudRate),
      };
    },
    expected: {
      read: {
        name: 'InvalidStateError',
        message: 'serial1 is in use by esptool',
        errno: 'EIO',
      },
      again: {
        name: 'InvalidStateError',
        message: 'serial1 is in use by esptool',
        errno: 'EIO',
      },
      open: ['serial1'],
      mac: { text: 'MAC: 24:0a:c4:12:34:56\n' },
      events: [
        ['open', 'serial1'],
        ['close', 'serial1', 'closed'],
      ],
      settings: [9600, 115200],
    },
  },
};
