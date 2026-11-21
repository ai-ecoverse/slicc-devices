import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import {
  embedder,
  FakeBluetoothCharacteristic,
  FakeBluetoothDevice,
  FakeBluetoothService,
  install,
} from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let os;
let hook;
let page = devices.create();
let fakes;
let device;
let gesture;

function fresh(extra = {}) {
  device = new FakeBluetoothDevice({ name: 'Polar H10', id: 'polar-1' }, extra);
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  fakes.bluetooth.devices.push(fakes.bluetooth.own(device));
  page = devices.create();
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const ble = (...args) => run(['ble', ...args]);

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
  os = await boot({ requests: hook });
  await os.kernel.groups.add('bluetooth', { gid: 110 });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('bluetooth', 'cone');
  await os.kernel.users.add({ name: 'guest' });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  hook.requests.length = 0;
  hook.prompts.length = 0;
  gesture = async () => true;
  fresh();
});

describe('ble on the kernel, with a fake navigator.bluetooth', () => {
  it('prints its help and version', async () => {
    assert.match((await ble()).stdout, /^ble - access Bluetooth LE devices via Web Bluetooth\n/);
    assert.deepEqual(await ble('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
  });

  it('lists devices, and says when there are none', async () => {
    assert.deepEqual(await ble('list'), {
      status: 0,
      stdout: 'ble1  Polar H10\n',
      stderr: '',
    });
    fakes.bluetooth.devices.length = 0;
    page = devices.create();
    assert.deepEqual(await ble('list'), {
      status: 0,
      stdout: 'no Bluetooth devices\n',
      stderr: '',
    });
  });

  it('requests with a typed activation, connects, reads, writes and disconnects', async () => {
    const probe = new FakeBluetoothDevice(
      { name: 'Battery', id: 'bat-1' },
      {
        services: [
          new FakeBluetoothService('battery_service', [
            new FakeBluetoothCharacteristic('battery_level', {
              properties: { read: true, write: true, notify: true },
              value: new Uint8Array([0x50]),
            }),
          ]),
        ],
      }
    );
    fakes.bluetooth.devices.length = 0;
    fakes.bluetooth.choose = () => probe;
    fakes = install(globalThis.navigator, {
      bluetooth: fakes.bluetooth,
      userActivation: { isActive: true },
    });
    page = devices.create();
    assert.deepEqual(
      await run(['ble', 'request', '--service', 'battery_service'], { tags: [typist] }),
      {
        status: 0,
        stdout: 'ble1  Battery\n',
        stderr: '',
      }
    );
    assert.deepEqual(await ble('connect', 'ble1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await ble('read', 'ble1', 'battery_service', 'battery_level'), {
      status: 0,
      stdout: '50\n',
      stderr: '',
    });
    assert.deepEqual(
      await run(['ble', 'write', 'ble1', 'battery_service', 'battery_level'], { stdin: '\x40' }),
      {
        status: 0,
        stdout: '',
        stderr: '',
      }
    );
    assert.deepEqual(await ble('disconnect', 'ble1'), { status: 0, stdout: '', stderr: '' });
  });

  it('refuses root-only writes for a bluetooth member without sudo', async () => {
    const result = await run(['ble', 'write', 'ble1', 'heart_rate', 'body_sensor_location'], {
      user: 'cone',
      stdin: '\x01',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ble\.write is not allowed for this user/);
  });

  it("says when seven's page does not answer", async () => {
    const alone = await createNodeAlone();
    try {
      const result = await alone.kernel.run(['ble', 'list'], { cwd: '/tmp' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs seven's page \(no page answers ble\.list\)/);
    } finally {
      alone.close();
    }
  });

  it('notifies until ^C and exits 130 with no error line', async () => {
    await ble('connect', 'ble1');
    const watching = await terminal([
      'ble',
      'notify',
      'ble1',
      'heart_rate',
      'heart_rate_measurement',
    ]);
    const char = device.services[0].characteristics[0];
    for (let i = 0; i < 400 && !char.notifying; i++) await sleep(10);
    assert.equal(char.notifying, true, 'ble notify did not start');
    char.notify(new Uint8Array([0x06, 0x3c]));
    await watching.until(/06 3c\r\n/);
    watching.term.write('\x03');
    assert.equal(await watching.term.exited, 130);
    assert.doesNotMatch(watching.output(), /ble:/);
  });

  it('prints services as JSON', async () => {
    const result = await ble('services', 'ble1');
    assert.equal(result.status, 0);
    const services = JSON.parse(result.stdout);
    assert.equal(services[0].uuid, '0000180d-0000-1000-8000-00805f9b34fb');
    assert.ok(services[0].characteristics.length >= 2);
  });
});

async function createNodeAlone() {
  const { createNodeKernel } = await import('@ai-ecoverse/slicc-kernel/node');
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join, relative, resolve } = await import('node:path');
  const root = resolve(import.meta.dirname, '../..');
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(path);
    }
    return out;
  };
  const kernel = await createNodeKernel({});
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const path of [
    join(root, 'package.json'),
    ...pkg.files.flatMap((d) => walk(join(root, d))),
  ]) {
    const rel = relative(root, path).replaceAll('\\', '/');
    await kernel.writeFile(`/node_modules/${pkg.name}/${rel}`, readFileSync(path));
  }
  return { kernel, close: () => kernel.terminate() };
}
