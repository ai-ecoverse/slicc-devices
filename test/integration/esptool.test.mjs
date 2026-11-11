import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeSerialPort, install } from './fake-devices.mjs';
import { FakeEsp } from './fake-esp.mjs';
import { boot } from './kernel.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });
const agent = JSON.stringify({ kind: 'agent', agentId: 'cone' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC = 'MAC: 24:0a:c4:12:34:56\n';
let os;
let hook;
let page = devices.create();
let fakes;
let port;
let device;
let approvals;

async function quick() {
  const real = await import('../../page/esptool.mjs');
  return {
    ...real,
    run: ({ plan, data }) => ({
      reply: Promise.resolve(`${JSON.stringify({ ...plan, body: data?.length ?? null })}\n`),
      done: Promise.resolve(),
    }),
  };
}

function fresh({ chip = 'ESP32', silent = false, stub = false } = {}) {
  device = new FakeEsp({ chip, silent });
  port = new FakeSerialPort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }, { device });
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  fakes.serial.ports.push(fakes.serial.own(port));
  page = devices.create(stub ? { esptool: quick } : {});
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const esptool = (...args) => run(['esptool', ...args]);
const kinds = () => hook.requests.map(({ kind }) => kind);

before(async () => {
  hook = embedder(() => page);
  os = await boot({
    requests: hook,
    approve: async (request) => {
      approvals.push(request.argv);
      return 'once';
    },
  });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('dialout', 'cone');
});

after(() => {
  os?.close();
});

beforeEach(() => {
  hook.requests.length = 0;
  hook.prompts.length = 0;
  approvals = [];
  fresh();
});

describe('esptool on the kernel: arguments', () => {
  it('prints its help with no arguments and with --help or -h', async () => {
    for (const args of [[], ['--help'], ['chip_id', '-h']]) {
      const result = await esptool(...args);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^esptool - flash ESP32 \/ ESP8266 chips via esptool-js\n\n/);
      assert.match(result.stdout, /write_flash <addr> <file>\.\.\. {7}Flash firmware at <addr>/);
      assert.match(result.stdout, /it needs root: sudo esptool/);
    }
    assert.deepEqual(hook.requests, []);
  });

  it('prints its package version with --version, and nothing else with it', async () => {
    assert.deepEqual(await esptool('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
    assert.deepEqual(await esptool('--version', 'chip_id'), {
      status: 2,
      stdout: '',
      stderr: 'esptool: --version: takes no other arguments (see esptool --help)\n',
    });
  });

  it('refuses bad arguments with exit 2 before it asks the page anything', async () => {
    const cases = [
      [['frobnicate'], "unknown subcommand 'frobnicate'"],
      [['--port', 'serial1'], "unknown subcommand ''"],
      [['chip_id', '--flash-mode', 'dio'], 'unknown option --flash-mode'],
      [['chip_id', '--port'], '--port: needs a value'],
      [['--chip', 'esp99', 'chip_id'], "invalid --chip: 'esp99'"],
      [
        ['--before', 'no_reset', 'chip_id'],
        '--before no_reset is not supported (only default_reset)',
      ],
      [['--after', 'soft-reset', 'run'], '--after soft-reset is not supported (only hard_reset)'],
      [['-b', '0', 'chip_id'], "invalid baud: '0'"],
      [['-b', 'fast', 'chip_id'], "invalid baud: 'fast'"],
      [['chip_id', 'extra'], 'chip_id: too many arguments'],
      [['-e', 'chip_id'], 'chip_id: --erase is for write_flash'],
      [['read_reg'], 'read_reg expects <addr>'],
      [['read_flash', '0x1000', '16'], 'read_flash expects <addr> <size> <file>'],
      [['read_flash', '0x1000', '0', 'x.bin'], "invalid size: '0'"],
      [['erase_region', '0x1000'], 'erase_region expects <addr> <size>'],
      [['write_flash', '0x1000'], 'write_flash expects <addr> <file> pairs'],
      [['write_flash', 'here', 'a.bin'], "invalid address: 'here'"],
      [['--pid', '0x1', 'chip_id'], '--pid needs --vid'],
      [['--vid', '0x10000', 'chip_id'], "invalid vid: '65536'"],
      [
        ['-p', 'serial1', '--vid', '0x10c4', 'chip_id'],
        '--vid and --pid choose a port, so they take no --port',
      ],
    ];
    for (const [args, message] of cases) {
      assert.deepEqual(
        await esptool(...args),
        { status: 2, stdout: '', stderr: `esptool: ${message} (see esptool --help)\n` },
        args.join(' ')
      );
    }
    assert.deepEqual(hook.requests, []);
  });

  it('takes Python esptool spellings: - or _, aliases, -p, -b, --x=y, --chip, --before and --after', async () => {
    fresh({ stub: true });
    const header = async (...args) => {
      const result = await esptool(...args);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const base = { baud: 115200, body: null };
    assert.deepEqual(await header('-p', 'serial1', 'read-mac'), { ...base, op: 'read_mac' });
    for (const alias of ['chip_info', 'chip-id', 'id'])
      assert.deepEqual(await header('--port=serial1', alias), { ...base, op: 'chip_id' });
    assert.deepEqual(
      await header(
        '--chip',
        'ESP32-S3',
        '-b',
        '460800',
        '--before',
        'default-reset',
        '--after=hard_reset',
        '--port',
        'serial1',
        'flash-id'
      ),
      { ...base, op: 'flash_id', baud: 460800, chip: 'esp32s3' }
    );
    assert.deepEqual(await header('-c', 'auto', '-p', 'serial1', 'read_reg', '0x3ff5a004'), {
      ...base,
      op: 'read_reg',
      address: 0x3ff5a004,
    });
    assert.deepEqual(await header('-p', 'serial1', 'erase-region', '0x9000', '8192'), {
      ...base,
      op: 'erase_region',
      address: 0x9000,
      size: 8192,
    });
    await os.kernel.writeFile('/tmp/app.bin', new Uint8Array([1, 2, 3]));
    assert.deepEqual(
      await header('-p', 'serial1', 'write_flash', '--erase_all', '-z', '0x10000', 'app.bin'),
      {
        ...base,
        op: 'write_flash',
        segments: [{ address: 0x10000, size: 3 }],
        erase: true,
        body: 3,
      }
    );
    assert.deepEqual(
      hook.requests.map(({ options }) => options.handle),
      Array(8).fill('serial1')
    );
  });

  it('checks segments, the 16 MiB limit and erase alignment itself, with EINVAL and exit 1', async () => {
    await os.kernel.writeFile('/tmp/a.bin', new Uint8Array(0x2000));
    await os.kernel.writeFile('/tmp/b.bin', new Uint8Array(0x10));
    await os.kernel.writeFile('/tmp/empty.bin', new Uint8Array(0));
    await os.kernel.writeFile('/tmp/huge.bin', new Uint8Array(16 * 1024 * 1024 + 1));
    const cases = [
      [
        ['write_flash', '0x1000', 'a.bin', '0x2000', 'b.bin'],
        'write_flash segments overlap or are out of order: 0x2000 starts before 0x3000',
      ],
      [
        ['write_flash', '0x8000', 'b.bin', '0x1000', 'b.bin'],
        'write_flash segments overlap or are out of order: 0x1000 starts before 0x8010',
      ],
      [['write_flash', '0x0', 'huge.bin'], 'write_flash takes at most 16 MiB'],
      [['write_flash', '0x1000', 'empty.bin'], 'empty.bin is empty'],
      [['erase_region', '0x1001', '0x1000'], 'erase_region needs a 4 KiB aligned address and size'],
    ];
    for (const [args, message] of cases) {
      assert.deepEqual(
        await esptool('-p', 'serial1', ...args),
        { status: 1, stdout: '', stderr: `esptool: ${message}\n` },
        args.join(' ')
      );
    }
    const missing = await esptool('-p', 'serial1', 'write_flash', '0x1000', 'nope.bin');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^esptool: .+\n$/);
    assert.deepEqual(hook.requests, []);
    assert.deepEqual(port.calls, []);
  });
});

describe('esptool on the kernel, with a fake ESP ROM loader', () => {
  it('flashes two files, reads them back to a file, and erases a region', async () => {
    const first = new Uint8Array(5000).map((_, i) => (i * 13) & 0xff);
    const second = new Uint8Array(3000).map((_, i) => 255 - (i & 0xff));
    await os.kernel.writeFile('/tmp/bootloader.bin', first);
    await os.kernel.writeFile('/tmp/app.bin', second);
    const written = await esptool(
      '--port',
      'serial1',
      'write-flash',
      '0x1000',
      'bootloader.bin',
      '0x10000',
      'app.bin'
    );
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, 'flash written\n');
    assert.match(written.stderr, /^esptool: Serial port WebSerial /);
    assert.match(written.stderr, /\nesptool: Hard resetting via RTS pin\.\.\.\n$/);
    const read = await esptool('-p', 'serial1', 'read_flash', '0x10000', '3000', 'back.bin');
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, 'Wrote 3000 bytes to /tmp/back.bin\n');
    assert.deepEqual(new Uint8Array(await os.kernel.readFile('/tmp/back.bin')), second);
    assert.deepEqual(device.flash.subarray(0x1000, 0x1000 + first.length), first);
    const erased = await esptool('-p', 'serial1', 'erase_region', '0x1000', '0x2000');
    assert.equal(erased.stdout, 'region erased\n');
    assert.ok(device.flash.subarray(0x1000, 0x3000).every((byte) => byte === 0xff));
  });

  it('needs root: a dialout member gets EACCES with the sudo hint, and sudo esptool works', async () => {
    assert.deepEqual(await run(['esptool', '-p', 'serial1', 'read_mac'], { user: 'cone' }), {
      status: 1,
      stdout: '',
      stderr:
        'esptool: serial.esptool is not allowed for this user (esptool needs root: sudo esptool -p serial1 read_mac)\n',
    });
    assert.deepEqual(hook.requests, []);
    assert.deepEqual(port.calls, []);
    const result = await run(['sudo', 'esptool', '-p', 'serial1', 'read_mac'], { user: 'cone' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, MAC);
    assert.deepEqual(approvals, [['esptool', '-p', 'serial1', 'read_mac']]);
    assert.deepEqual(
      hook.requests.map(({ kind, stamp }) => [kind, stamp.uid]),
      [['serial.esptool', 0]]
    );
  });

  it('runs serial.request first without --port, with the click line for an agent', async () => {
    const board = new FakeSerialPort(
      { usbVendorId: 0x10c4, usbProductId: 0xea61 },
      { device: new FakeEsp() }
    );
    fakes.serial.choose = () => board;
    const result = await run(['esptool', '--vid', '0x10c4', '--pid', '0xea61', 'read_mac'], {
      tag: agent,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, MAC);
    assert.match(
      result.stderr,
      /^esptool: waiting for a click in seven's tab: choose a serial port\nesptool: /
    );
    assert.deepEqual(kinds(), ['serial.request', 'serial.esptool']);
    assert.deepEqual(hook.requests[0].options, {
      filters: [{ usbVendorId: 0x10c4, usbProductId: 0xea61 }],
    });
    assert.equal(hook.requests[1].options.handle, 'serial2');
    assert.equal(hook.prompts.length, 1);
    fakes.userActivation.isActive = true;
    fakes.serial.choose = () => undefined;
    assert.deepEqual(await run(['esptool', 'chip_id'], { tag: typist }), {
      status: 1,
      stdout: '',
      stderr: 'esptool: no serial port was chosen\n',
    });
  });

  it('fails on a --chip mismatch, as Python esptool does', async () => {
    fresh({ chip: 'ESP8266' });
    const result = await esptool('--chip', 'esp32', '-p', 'serial1', 'erase_flash');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^esptool: this chip is ESP8266, not esp32 \(wrong --chip\?\)\n$/m);
    assert.ok(!device.seen.includes(0xd0));
  });

  it('exits 130 on ^C with no error line, and the port closes', async () => {
    fresh({ silent: true });
    let output = '';
    const term = await os.kernel.openTerminal(['esptool', '-p', 'serial1', 'chip_id'], {
      cwd: '/tmp',
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
    });
    for (let i = 0; i < 400 && !port.readable; i++) await sleep(10);
    await sleep(300);
    term.write('\x03');
    assert.equal(await term.exited, 130);
    assert.doesNotMatch(output, /no ESP chip answered/);
    for (let i = 0; i < 400 && page.ports.open().length; i++) await sleep(10);
    assert.deepEqual(page.ports.open(), []);
    assert.equal(port.readable, null);
  });
});

describe('outside SLICC', () => {
  it('says it needs seven page when no page answers', async () => {
    const bare = await boot();
    try {
      for (const [args, kind] of [
        [['-p', 'serial1', 'chip_id'], 'serial.esptool'],
        [['read_mac'], 'serial.request'],
      ]) {
        assert.deepEqual(await bare.kernel.run(['esptool', ...args], { cwd: '/tmp' }), {
          status: 1,
          stdout: '',
          stderr: `esptool: needs seven's page (no page answers ${kind})\n`,
        });
      }
    } finally {
      bare.close();
    }
  });
});
