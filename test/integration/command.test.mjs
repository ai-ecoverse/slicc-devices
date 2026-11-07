import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeSerialPort, install } from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let os;
let hook;
let page = devices.create();
let fakes;
let port;
let gesture;
let approvals;

function fresh(options = {}) {
  port = new FakeSerialPort({ usbVendorId: 0x2e8a, usbProductId: 0x0005 }, options);
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  fakes.serial.ports.push(fakes.serial.own(port));
  page = devices.create();
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const serial = (...args) => run(['serial', ...args]);

async function terminal(argv, options = {}) {
  let output = '';
  const term = await os.kernel.openTerminal(argv, {
    cwd: '/tmp',
    onData: (data) => {
      output += new TextDecoder().decode(data);
    },
    ...options,
  });
  return {
    term,
    output: () => output,
    until: async (pattern) => {
      for (let i = 0; i < 400 && !pattern.test(output); i++) await sleep(10);
      assert.match(output, pattern);
    },
  };
}

before(async () => {
  hook = embedder(() => page, {}, { gesture: (...args) => gesture(...args) });
  os = await boot({
    requests: hook,
    approve: async (request) => {
      approvals.push(request.argv);
      return 'once';
    },
  });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('dialout', 'cone');
  await os.kernel.users.add({ name: 'guest' });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  hook.requests.length = 0;
  hook.prompts.length = 0;
  gesture = async () => true;
  approvals = [];
  fresh({ echo: true });
});

describe('serial on the kernel, with a fake navigator.serial', () => {
  it('prints its help with no arguments and with --help or -h', async () => {
    for (const args of [[], ['--help'], ['list', '-h']]) {
      const result = await serial(...args);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^serial - access serial ports via Web Serial\n\nUsage: serial/);
      assert.match(result.stdout, /console <handle> \[--baud N\] {7}Raw terminal on the port/);
    }
    assert.deepEqual(hook.requests, []);
  });

  it('prints its package version with --version', async () => {
    assert.deepEqual(await serial('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
    assert.deepEqual(hook.requests, []);
  });

  it('lists ports as six does, and says when there are none', async () => {
    fakes.serial.ports.push(
      fakes.serial.own(new FakeSerialPort({ bluetoothServiceClassId: 4353 })),
      fakes.serial.own(new FakeSerialPort({}))
    );
    await serial('open', 'serial1');
    assert.deepEqual(await serial('list'), {
      status: 0,
      stdout:
        'serial1\t0x2e8a:0x0005 [open]\nserial2\t(bluetooth 4353)\nserial3\t(native serial)\n',
      stderr: '',
    });
    fakes.serial.ports.length = 0;
    page = devices.create();
    assert.deepEqual(await serial('list'), {
      status: 0,
      stdout: 'no granted serial ports\n',
      stderr: '',
    });
  });

  it('requests a port at once when typed in an active terminal', async () => {
    const chosen = new FakeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 });
    fakes.serial.choose = () => chosen;
    fakes.userActivation.isActive = true;
    const result = await run(['serial', 'request', '--vid', '0x303a', '--pid', '4097'], {
      tag: typist,
    });
    assert.deepEqual(result, { status: 0, stdout: 'serial2\t0x303a:0x1001\n', stderr: '' });
    assert.deepEqual(hook.prompts, []);
    assert.deepEqual(fakes.serial.calls.at(-1), [
      'requestPort',
      { filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] },
    ]);
  });

  it('says it waits for a click, then prompts, when an agent requests a port', async () => {
    fakes.serial.choose = () => new FakeSerialPort({ usbVendorId: 1, usbProductId: 2 });
    const agent = JSON.stringify({ kind: 'agent', agentId: 'cone' });
    const result = await run(['serial', 'request'], { tag: agent });
    assert.deepEqual(result, {
      status: 0,
      stdout: 'serial2\t0x0001:0x0002\n',
      stderr: "serial: waiting for a click in seven's tab: choose a serial port\n",
    });
    assert.deepEqual(
      hook.prompts.map(({ title, body }) => [title, body]),
      [
        [
          'Choose a serial port',
          "The agent cone wants to use a serial port. Click Choose, then pick it in the browser's list.",
        ],
      ]
    );
    gesture = async () => false;
    assert.deepEqual(await run(['serial', 'request'], { tag: agent }), {
      status: 1,
      stdout: '',
      stderr:
        "serial: waiting for a click in seven's tab: choose a serial port\nserial: no serial port was chosen\n",
    });
    fakes.userActivation.isActive = true;
    fakes.serial.choose = () => undefined;
    assert.deepEqual(await run(['serial', 'request'], { tag: typist }), {
      status: 1,
      stdout: '',
      stderr: 'serial: no serial port was chosen\n',
    });
  });

  it('opens with six defaults and flags, closes, and reads and writes in between', async () => {
    assert.deepEqual(await serial('open', 'serial1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(port.options, { baudRate: 9600 });
    await serial('close', 'serial1');
    await serial(
      'open',
      'serial1',
      '--baud',
      '115200',
      '--data-bits',
      '7',
      '--stop-bits',
      '2',
      '--parity',
      'odd',
      '--flow-control',
      'hardware',
      '--buffer-size',
      '0x1000'
    );
    assert.deepEqual(port.options, {
      baudRate: 115200,
      dataBits: 7,
      stopBits: 2,
      parity: 'odd',
      flowControl: 'hardware',
      bufferSize: 4096,
    });
    assert.deepEqual(await run(['serial', 'write', 'serial1'], { stdin: 'hello\r\nworld' }), {
      status: 0,
      stdout: '12 bytes written\n',
      stderr: '',
    });
    assert.equal(port.text(), 'hello\r\nworld');
    assert.deepEqual(await serial('read', 'serial1', '--until', '0d0a', '--hex'), {
      status: 0,
      stdout: '68 65 6c 6c 6f 0d 0a\n',
      stderr: '',
    });
    assert.deepEqual(await serial('read', 'serial1', '--bytes', '3'), {
      status: 0,
      stdout: 'wor',
      stderr: '',
    });
    assert.deepEqual(await serial('read', 'serial1', '--timeout-ms', '50'), {
      status: 0,
      stdout: 'ld',
      stderr: '',
    });
    assert.deepEqual(await serial('read', 'serial1', '--timeout-ms', '20', '--hex'), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    assert.deepEqual(await serial('close', 'serial1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await serial('close', 'serial1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await serial('read', 'serial1'), {
      status: 1,
      stdout: '',
      stderr: 'serial: serial1 is not open (serial open serial1 --baud N)\n',
    });
  });

  it('gets and sets signals in six format', async () => {
    await serial('open', 'serial1');
    assert.deepEqual(await serial('signals', 'serial1', 'get'), {
      status: 0,
      stdout: 'cts=1 dcd=0 dsr=1 ri=0\n',
      stderr: '',
    });
    assert.deepEqual(
      await serial('signals', 'serial1', 'set', '--dtr', 'on', '--rts', 'off', '--break', '0'),
      { status: 0, stdout: '', stderr: '' }
    );
    assert.deepEqual(port.outputs, [
      { dataTerminalReady: true, requestToSend: false, break: false },
    ]);
  });

  it('refuses reads and writes over 4 MiB before asking the page', async () => {
    await serial('open', 'serial1');
    hook.requests.length = 0;
    assert.deepEqual(await serial('read', 'serial1', '--bytes', String(4 * 1024 * 1024 + 1)), {
      status: 1,
      stdout: '',
      stderr: 'serial: read --bytes exceeds 4 MiB limit\n',
    });
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    assert.deepEqual(await run(['serial', 'write', 'serial1'], { stdin: big }), {
      status: 1,
      stdout: '',
      stderr: 'serial: write payload exceeds 4 MiB limit\n',
    });
    assert.deepEqual(hook.requests, []);
  });

  it('says the page error and exits 1, or the usage error and exits 2', async () => {
    assert.deepEqual(await serial('open', 'serial9'), {
      status: 1,
      stdout: '',
      stderr: "serial: unknown serial handle 'serial9'\n",
    });
    const usage = [
      [['bogus'], "unknown subcommand 'bogus'"],
      [['open'], 'open: handle required'],
      [['read'], 'read: handle required'],
      [['open', 'serial1', '--baud'], '--baud: needs a value'],
      [['open', 'serial1', '--baud', 'fast'], "invalid baud: 'fast'"],
      [['open', 'serial1', '--baud', '0'], "invalid baud: '0'"],
      [['open', 'serial1', '--data-bits', '6'], "invalid data-bits: '6' (use 7 or 8)"],
      [['open', 'serial1', '--stop-bits', '3'], "invalid stop-bits: '3' (use 1 or 2)"],
      [['open', 'serial1', '--parity', 'mark'], "invalid --parity: 'mark'"],
      [['open', 'serial1', '--flow-control', 'xon'], "invalid --flow-control: 'xon'"],
      [['open', 'serial1', '--hex'], 'open: unknown option --hex'],
      [['list', '--vid', '1'], 'list: unknown option --vid'],
      [['list', 'serial1'], 'list: too many arguments'],
      [['request', '--pid', '1'], 'request: --pid needs --vid'],
      [['request', '--vid', '0x10000'], "invalid vid: '65536'"],
      [['read', 'serial1', '--until', 'xyz'], "invalid hex string: 'xyz'"],
      [['read', 'serial1', '--follow', '--bytes', '3'], 'read: --follow takes no --bytes'],
      [['signals', 'serial1'], 'signals: handle and get|set required'],
      [['signals', 'serial1', 'flip'], "signals: unknown action 'flip' (use get|set)"],
      [['signals', 'serial1', 'set'], 'signals set: needs --dtr, --rts or --break'],
      [['signals', 'serial1', 'set', '--dtr', 'maybe'], "invalid dtr: 'maybe' (use on/off)"],
      [['signals', 'serial1', 'get', '--dtr', 'on'], 'signals get: takes no flags'],
      [['console', 'serial1'], 'console: needs a terminal on stdin'],
    ];
    for (const [args, message] of usage) {
      assert.deepEqual(
        await serial(...args),
        { status: 2, stdout: '', stderr: `serial: ${message} (see serial --help)\n` },
        args.join(' ')
      );
    }
  });

  it('ends a read with EIO when the port is unplugged', async () => {
    await serial('open', 'serial1');
    const reading = serial('read', 'serial1', '--follow');
    await sleep(200);
    port.feed('boot');
    await sleep(50);
    port.unplug();
    assert.deepEqual(await reading, {
      status: 1,
      stdout: 'boot',
      stderr: 'serial: serial1 was unplugged\n',
    });
  });

  it('follows until ^C and exits 130 with no error line', async () => {
    await serial('open', 'serial1');
    const follow = await terminal(['serial', 'read', 'serial1', '--follow', '--hex']);
    await sleep(300);
    port.feed('ab');
    await follow.until(/61 62\r\n/);
    await sleep(1100);
    port.feed('c');
    await follow.until(/63\r\n/);
    follow.term.write('\x03');
    assert.equal(await follow.term.exited, 130);
    assert.doesNotMatch(follow.output(), /serial:/);
    const plain = await terminal(['serial', 'read', 'serial1', '--timeout-ms', '0']);
    await sleep(300);
    plain.term.write('\x03');
    assert.equal(await plain.term.exited, 130);
    assert.doesNotMatch(plain.output(), /serial:/);
    assert.deepEqual(await serial('read', 'serial1', '--timeout-ms', '20'), {
      status: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('runs a console: device output, typed keys, C-a C-a, ^C as a byte, and C-a C-x', async () => {
    const view = await terminal(['serial', 'console', 'serial1']);
    await view.until(/serial: serial1 \(C-a C-x quits\)/);
    assert.deepEqual(port.options, { baudRate: 115200 });
    port.feed('>>> ');
    await view.until(/>>> /);
    view.term.write('ls\r');
    await view.until(/ls\r/);
    view.term.write('\x01\x01\x03');
    for (let i = 0; i < 200 && !port.text().endsWith('\x01\x03'); i++) await sleep(10);
    assert.equal(port.text(), 'ls\r\x01\x03');
    view.term.write('\x01\x18');
    assert.equal(await view.term.exited, 0);
    assert.equal(page.ports.open().length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(port.calls.map(([name]) => name))), [
      'open',
      'close',
    ]);
  });

  it('keeps a port it did not open open, and says the port was closed in seven', async () => {
    await serial('open', 'serial1', '--baud', '57600');
    const view = await terminal(['serial', 'console', 'serial1', '--baud', '9600']);
    await view.until(/C-a C-x quits/);
    await sleep(200);
    await page.ports.close('serial1');
    assert.equal(await view.term.exited, 0);
    assert.match(view.output(), /serial: serial1 was closed/);
    assert.deepEqual(port.options, null);
    assert.deepEqual(port.calls[0], ['open', { baudRate: 57600 }]);
  });
});

describe('permissions', () => {
  it('lets a dialout member read but not write, and sudo serial write works', async () => {
    await serial('open', 'serial1');
    port.feed('hi');
    await sleep(20);
    assert.deepEqual(
      await run(['serial', 'read', 'serial1', '--timeout-ms', '20'], { user: 'cone' }),
      {
        status: 0,
        stdout: 'hi',
        stderr: '',
      }
    );
    assert.deepEqual(await run(['serial', 'list'], { user: 'cone' }), {
      status: 0,
      stdout: 'serial1\t0x2e8a:0x0005 [open]\n',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'write', 'serial1'], { user: 'cone', stdin: 'x' }), {
      status: 1,
      stdout: '',
      stderr:
        'serial: serial.write is not allowed for this user (writes need root: sudo serial write serial1)\n',
    });
    assert.deepEqual(
      await run(['serial', 'signals', 'serial1', 'set', '--dtr', 'on'], { user: 'cone' }),
      {
        status: 1,
        stdout: '',
        stderr:
          'serial: serial.control is not allowed for this user (writes need root: sudo serial signals serial1 set --dtr on)\n',
      }
    );
    assert.equal(port.text(), '');
    assert.deepEqual(
      await run(['sudo', 'serial', 'write', 'serial1'], { user: 'cone', stdin: 'ok' }),
      { status: 0, stdout: '2 bytes written\n', stderr: '' }
    );
    assert.equal(port.text(), 'ok');
    assert.deepEqual(approvals, [['serial', 'write', 'serial1']]);
    assert.deepEqual(
      hook.requests.filter(({ kind }) => kind === 'serial.write').map(({ stamp }) => stamp.uid),
      [0]
    );
  });

  it("keeps writes root's only through session: false, since cone is the session user here", async () => {
    const before = { ...devices.kinds };
    const old = embedder(() => page, {
      'serial.write': { group: 'nogroup' },
      'serial.control': { group: 'nogroup' },
    });
    const loose = await boot({ requests: old });
    try {
      await loose.kernel.users.add({ name: 'cone' });
      await loose.kernel.groups.addMember('dialout', 'cone');
      const as = (args, options = {}) =>
        loose.kernel.run(['serial', ...args], { cwd: '/tmp', user: 'cone', ...options });
      await as(['open', 'serial1']);
      assert.deepEqual(await as(['write', 'serial1'], { stdin: 'no' }), {
        status: 0,
        stdout: '2 bytes written\n',
        stderr: '',
      });
      assert.equal((await as(['signals', 'serial1', 'set', '--dtr', 'on'])).status, 0);
      assert.deepEqual(old.requests.map(({ kind, stamp }) => [kind, stamp.uid]).slice(0, 2), [
        ['serial.open', 1000],
        ['serial.write', 1000],
      ]);
    } finally {
      loose.close();
    }
    assert.deepEqual(devices.kinds, before);
    assert.match(
      (await run(['serial', 'write', 'serial1'], { user: 'cone', stdin: 'x' })).stderr,
      /serial\.write is not allowed for this user/
    );
    assert.equal(
      (await run(['serial', 'signals', 'serial1', 'set', '--dtr', 'on'], { user: 'cone' })).status,
      1
    );
  });

  it('refuses every serial kind to a user outside dialout', async () => {
    assert.deepEqual(await run(['serial', 'list'], { user: 'guest' }), {
      status: 1,
      stdout: '',
      stderr: 'serial: serial.list is not allowed for this user\n',
    });
    assert.deepEqual(hook.requests, []);
  });

  it('says writes need root once in a console, and goes on reading', async () => {
    const view = await terminal(['serial', 'console', 'serial1'], { user: 'cone' });
    await view.until(/C-a C-x quits/);
    view.term.write('a');
    await view.until(/writes need root: sudo serial console serial1/);
    view.term.write('b');
    port.feed('still here');
    await view.until(/still here/);
    view.term.write('\x01\x18');
    assert.equal(await view.term.exited, 0);
    assert.equal(view.output().match(/writes need root/g).length, 1);
    assert.equal(port.text(), '');
  });
});

describe('outside SLICC', () => {
  it('says it needs seven page when no page answers', async () => {
    const bare = await boot();
    try {
      for (const args of [['list'], ['open', 'serial1'], ['read', 'serial1', '--follow']]) {
        const kind = { list: 'serial.list', open: 'serial.open', read: 'serial.read' }[args[0]];
        assert.deepEqual(await bare.kernel.run(['serial', ...args], { cwd: '/tmp' }), {
          status: 1,
          stdout: '',
          stderr: `serial: needs seven's page (no page answers ${kind})\n`,
        });
      }
    } finally {
      bare.close();
    }
  });
});
