const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOARD = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
const HINT = '(press RESET, or esptool --port serial1 run)';

function bench({ devices, fake, esp }, { chip = 'ESP32', silent = false, enabled } = {}) {
  const device = new esp.FakeEsp({ chip, silent });
  const port = new fake.FakeSerialPort(BOARD, { device });
  const serial = new fake.FakeSerial({ ports: [port] });
  const overrides = { navigator: { serial } };
  if (enabled) overrides.enabled = enabled;
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

export const rows = {
  chip: {
    title:
      'chip_id detects the ESP32 through the stub, prints six lines, shows the port open, and paces progress',
    async run(deps) {
      const b = bench(deps);
      const result = await reply(b.tool({ op: 'chip_id' }), deps.fake);
      const gaps = b.lines.slice(1).map(([at], i) => at - b.lines[i][0]);
      return {
        result,
        lines: b.lines.map(([, line]) => line),
        paced: gaps.every((gap) => gap >= 250),
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
      lines: [
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
      ],
      paced: true,
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
      const lines = b.lines.map(([, line]) => line);
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
        writing: lines.some((line) => /^Writing at 0x[0-9a-f]+\.\.\. \(\d+%\)$/.test(line)),
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
      writing: true,
      one: true,
      two: true,
      gap: true,
      erased: { text: 'region erased\n' },
      wiped: true,
      kept: true,
      events: 8,
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
