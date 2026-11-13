import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeSerialPort, install } from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const FTDI = { usbVendorId: 0x0403, usbProductId: 0x6001 };
const PICO = { usbVendorId: 0x2e8a, usbProductId: 0x0005 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let os;
let hook;
let page = devices.create();
let fakes;
let nodes;
let events;
let on;
let approvals;

async function until(check) {
  for (let i = 0; i < 500 && !check(); i++) await sleep(10);
  assert.ok(check(), String(check));
}

function world(ports) {
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  const owned = ports.map((port) => fakes.serial.own(port));
  fakes.serial.ports.push(...owned);
  on = true;
  page = devices.create({ enabled: () => on });
  events = [];
  page.ports.watch((event) => events.push(event));
  nodes = page.devices.nodes(os.kernel);
  return owned;
}

const settled = () =>
  until(() => {
    const listed = page.ports.list();
    return listed.length > 0 && listed.every((port) => port.node);
  });

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const sh = (script, options) => run(['sh', '-c', script], options);
const brief = (list) =>
  list.map((event) => [event.type, event.handle, event.node ?? event.why ?? null]);

before(async () => {
  hook = embedder(() => page);
  os = await boot({
    requests: hook,
    devices: { open: (request) => page.devices.open(request) },
    approve: async (request) => {
      approvals.push(request.argv);
      return 'once';
    },
  });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('dialout', 'cone');
  await os.kernel.users.add({ name: 'guest' });
  await os.kernel.writeFile(
    '/node_modules/ttyprobe/probe.mjs',
    readFileSync(new URL('./tty-probe.mjs', import.meta.url))
  );
  await os.kernel.writeFile(
    '/node_modules/ttyprobe/package.json',
    JSON.stringify({
      name: 'ttyprobe',
      version: '1.0.0',
      slicc: { commands: { ttyprobe: { abi: 'js', module: 'probe.mjs' } } },
    })
  );
});

after(() => {
  os?.close();
});

beforeEach(() => {
  approvals = [];
});

afterEach(async () => {
  await nodes?.stop();
  nodes = null;
});

describe('serial device nodes on the kernel, with a fake navigator.serial', () => {
  it('exports the devices hook and refuses a kernel without devices', () => {
    assert.deepEqual(Object.keys(devices.devices).sort(), ['nodes', 'open']);
    assert.equal(devices.default.devices, devices.devices);
    assert.throws(() => devices.create().devices.nodes({}), {
      name: 'TypeError',
      message: 'this kernel has no devices (slicc-kernel 1.183.0 or later)',
    });
  });

  it('adds a root:dialout 0640 node per granted port, with its by-id link, and lists it', async () => {
    world([
      new FakeSerialPort(FTDI),
      new FakeSerialPort(PICO),
      new FakeSerialPort(FTDI),
      new FakeSerialPort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
      new FakeSerialPort({ bluetoothServiceClassId: 4353 }),
    ]);
    await settled();
    const listing = await sh('ls /dev/ttyUSB* /dev/ttyACM*; ls /dev/serial/by-id');
    assert.deepEqual(listing, {
      status: 0,
      stdout: [
        '/dev/ttyACM0',
        '/dev/ttyACM1',
        '/dev/ttyUSB0',
        '/dev/ttyUSB1',
        '/dev/ttyUSB2',
        'usb-0403_6001-if00',
        'usb-0403_6001-if00-1',
        'usb-10c4_ea60-if00',
        'usb-2e8a_0005-if00',
        '',
      ].join('\n'),
      stderr: '',
    });
    const probe = await run([
      'ttyprobe',
      'stat',
      '/dev/ttyUSB1',
      '/dev/serial/by-id/usb-0403_6001-if00-1',
    ]);
    assert.deepEqual(JSON.parse(probe.stdout), {
      mode: '20640',
      uid: 0,
      gid: 20,
      link: '../../ttyUSB1',
    });
    assert.deepEqual(await run(['serial', 'list'], { user: 'cone' }), {
      status: 0,
      stdout: [
        'serial1\t0x0403:0x6001\t/dev/ttyUSB0',
        'serial2\t0x2e8a:0x0005\t/dev/ttyACM0',
        'serial3\t0x0403:0x6001\t/dev/ttyUSB1',
        'serial4\t0x10c4:0xea60\t/dev/ttyUSB2',
        'serial5\t(bluetooth 4353)\t/dev/ttyACM1',
        '',
      ].join('\n'),
      stderr: '',
    });
    await nodes.stop();
    nodes = null;
    assert.equal((await sh('ls /dev/ttyUSB0')).status, 2);
    assert.equal((await sh('ls /dev/serial/by-id/usb-0403_6001-if00')).status, 2);
    assert.equal(page.ports.list()[0].node, undefined);
  });

  it('prints a chosen or plugged port with its node at once', async () => {
    world([new FakeSerialPort(PICO)]);
    fakes.serial.choose = () => new FakeSerialPort(FTDI);
    assert.deepEqual(await run(['serial', 'request', '--vid', '0x0403']), {
      status: 0,
      stdout: 'serial2\t0x0403:0x6001\t/dev/ttyUSB0\n',
      stderr: "serial: waiting for a click in seven's tab: choose a serial port\n",
    });
    fakes.serial.plug(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }));
    assert.deepEqual(await run(['serial', 'list']), {
      status: 0,
      stdout: [
        'serial1\t0x2e8a:0x0005\t/dev/ttyACM0',
        'serial2\t0x0403:0x6001\t/dev/ttyUSB0',
        'serial3\t0x1a86:0x7523\t/dev/ttyUSB1',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  it('turns stty -F /dev/ttyUSB0 115200 raw into one reopen at 115200', async () => {
    const [port] = world([new FakeSerialPort(FTDI)]);
    await settled();
    assert.deepEqual(await sh('stty -F /dev/ttyUSB0 115200 raw'), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    const line = { dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
    assert.deepEqual(port.calls, [
      ['open', { baudRate: 9600, ...line }],
      ['close'],
      ['open', { baudRate: 115200, ...line }],
      ['close'],
    ]);
    port.calls.length = 0;
    assert.match((await sh('stty -F /dev/ttyUSB0')).stdout, /^speed 115200 baud;/);
    assert.deepEqual(port.calls, [['open', { baudRate: 115200, ...line }], ['close']]);
  });

  it('keeps what was read when a descriptor changes the speed', async () => {
    const [port] = world([new FakeSerialPort(FTDI, { boot: 'abc' })]);
    await settled();
    assert.deepEqual(
      await sh('exec 3</dev/ttyUSB0; stty 57600 <&3; head -c 3 <&3', { user: 'cone' }),
      { status: 0, stdout: 'abc', stderr: '' }
    );
    assert.deepEqual(
      port.calls.map(([name, options]) => (options ? [name, options.baudRate] : [name])),
      [['open', 9600], ['close'], ['open', 57600], ['close']]
    );
  });

  it('lets a dialout member cat the node, not open it for writing, and nobody else in', async () => {
    const [port] = world([new FakeSerialPort(FTDI, { boot: 'hello' })]);
    await settled();
    assert.deepEqual(await run(['head', '-c', '5', '/dev/ttyUSB0'], { user: 'cone' }), {
      status: 0,
      stdout: 'hello',
      stderr: '',
    });
    assert.deepEqual(await sh('printf x > /dev/ttyUSB0', { user: 'cone' }), {
      status: 1,
      stdout: '',
      stderr: 'sh: line 1: /dev/ttyUSB0: Permission denied\n',
    });
    assert.deepEqual(await sh('exec 3<>/dev/ttyUSB0', { user: 'cone' }), {
      status: 1,
      stdout: '',
      stderr: 'sh: line 1: /dev/ttyUSB0: Permission denied\n',
    });
    assert.equal((await run(['cat', '/dev/ttyUSB0'], { user: 'guest' })).status, 1);
    assert.deepEqual(port.written, []);
    assert.equal(port.calls.filter(([name]) => name === 'open').length, 1);
  });

  it('reads and writes raw through sudo', async () => {
    const [port] = world([new FakeSerialPort(FTDI, { echo: true })]);
    await settled();
    const result = await run(
      ['sudo', 'sh', '-c', 'exec 3<>/dev/ttyUSB0; printf ping >&3; head -c 4 <&3'],
      { user: 'cone' }
    );
    assert.deepEqual(result, { status: 0, stdout: 'ping', stderr: '' });
    assert.equal(port.text(), 'ping');
    assert.equal(approvals.length, 1);
  });

  it('keeps the node and the serial command out of each other', async () => {
    world([new FakeSerialPort(FTDI)]);
    await settled();
    const held = await sh(
      'exec 3</dev/ttyUSB0; serial open serial1; serial read serial1; serial close serial1; serial list; cat /dev/ttyUSB0'
    );
    assert.deepEqual(held, {
      status: 1,
      stdout: 'serial1\t0x0403:0x6001 [open]\t/dev/ttyUSB0\n',
      stderr: [
        'serial: serial1 is open as /dev/ttyUSB0',
        'serial: serial1 is open as /dev/ttyUSB0',
        'serial: serial1 is open as /dev/ttyUSB0',
        'cat: /dev/ttyUSB0: Resource busy',
        '',
      ].join('\n'),
    });
    assert.deepEqual(brief(events), [
      ['open', 'serial1', '/dev/ttyUSB0'],
      ['close', 'serial1', 'closed'],
    ]);
    const cli = await sh('serial open serial1; cat /dev/ttyUSB0; serial close serial1');
    assert.deepEqual(cli, { status: 0, stdout: '', stderr: 'cat: /dev/ttyUSB0: I/O error\n' });
  });

  it('removes the node on unplug, hangs up an open one, and gives the name back on re-enumeration', async () => {
    const [port] = world([new FakeSerialPort(FTDI)]);
    await settled();
    const reading = run(['cat', '/dev/ttyUSB0']);
    await until(() => port.readable);
    port.feed('partial');
    await sleep(20);
    port.unplug();
    const result = await reading;
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'partial');
    assert.match(result.stderr, /^cat: \/dev\/ttyUSB0: /);
    await until(() => page.ports.list().length === 0);
    assert.equal((await sh('ls /dev/ttyUSB0 /dev/serial/by-id/usb-0403_6001-if00')).status, 2);
    fakes.serial.plug(new FakeSerialPort(FTDI, { boot: 'back' }));
    await settled();
    assert.deepEqual(await sh('head -c 4 /dev/serial/by-id/usb-0403_6001-if00; serial list'), {
      status: 0,
      stdout: 'backserial1\t0x0403:0x6001\t/dev/ttyUSB0\n',
      stderr: '',
    });
  });

  it('hangs up an open node on Close in seven and on the switch, and refuses it while off', async () => {
    const [port] = world([new FakeSerialPort(FTDI, { boot: 'hello' })]);
    await settled();
    let reading = run(['cat', '/dev/ttyUSB0'], { user: 'cone' });
    await until(() => port.readable);
    assert.deepEqual(
      page.ports.open().map(({ handle, node, open }) => [handle, node, open]),
      [['serial1', '/dev/ttyUSB0', true]]
    );
    await page.ports.close('serial1');
    assert.deepEqual(await reading, { status: 0, stdout: 'hello', stderr: '' });
    reading = run(['cat', '/dev/ttyUSB0'], { user: 'cone' });
    await until(() => port.readable);
    on = false;
    await page.ports.closeAll();
    assert.deepEqual(await reading, { status: 0, stdout: 'hello', stderr: '' });
    assert.deepEqual(await run(['cat', '/dev/ttyUSB0'], { user: 'cone' }), {
      status: 1,
      stdout: '',
      stderr: 'cat: /dev/ttyUSB0: Permission denied\n',
    });
    assert.deepEqual(brief(events), [
      ['open', 'serial1', '/dev/ttyUSB0'],
      ['close', 'serial1', 'seven'],
      ['open', 'serial1', '/dev/ttyUSB0'],
      ['close', 'serial1', 'seven'],
    ]);
    assert.equal(port.readable, null);
  });

  it('drops a node open still in flight when the switch goes off', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const [port] = world([new FakeSerialPort(FTDI, { gate })]);
    await settled();
    const reading = run(['cat', '/dev/ttyUSB0']);
    await until(() => port.calls.length === 1);
    await page.ports.closeAll();
    release();
    assert.deepEqual(await reading, {
      status: 1,
      stdout: '',
      stderr: 'cat: /dev/ttyUSB0: Permission denied\n',
    });
    assert.deepEqual(port.calls.at(-1), ['close']);
    assert.equal(port.readable, null);
    assert.deepEqual(events, []);
  });

  it("sets DTR and RTS on the fake through TIOCMBIS and TIOCMBIC, reads the inputs, and keeps the lines root's", async () => {
    const [port] = world([new FakeSerialPort(FTDI)]);
    await settled();
    port.inputs.dataCarrierDetect = true;
    const result = await run(['ttyprobe', 'modem', '/dev/ttyUSB0']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      first: { dtr: true, rts: true, cts: true, dsr: true, cd: true, ri: false },
      last: { dtr: true, rts: false, cts: true, dsr: true, cd: true, ri: false },
    });
    const reader = await run(['ttyprobe', 'modem', '/dev/ttyUSB0', 'ro'], { user: 'cone' });
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout), {
      first: { dtr: true, rts: true, cts: true, dsr: true, cd: true, ri: false },
      refused: 'EACCES',
    });
    assert.deepEqual(port.outputs, [
      { dataTerminalReady: false, requestToSend: true },
      { dataTerminalReady: false, requestToSend: false },
      { dataTerminalReady: true, requestToSend: false },
    ]);
  });
});
