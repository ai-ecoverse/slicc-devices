import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeHIDDevice, install } from './fake-devices.mjs';
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
  device = new FakeHIDDevice(
    {
      vendorId: 0x320f,
      productId: 0x5044,
      productName: 'Nano Pad',
      collections: [{ usagePage: 0xff60, usage: 0x61 }],
    },
    extra
  );
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  fakes.hid.devices.push(fakes.hid.own(device));
  page = devices.create();
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const hid = (...args) => run(['hid', ...args]);

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
  await os.kernel.groups.add('plugdev', { gid: 46 });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('plugdev', 'cone');
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

describe('hid on the kernel, with a fake navigator.hid', () => {
  it('prints its help and version', async () => {
    assert.match((await hid()).stdout, /^hid - access HID devices via WebHID\n/);
    assert.deepEqual(await hid('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
  });

  it('lists devices as six does, and says when there are none', async () => {
    assert.deepEqual(await hid('list'), {
      status: 0,
      stdout: 'hid1\t0x320f:0x5044\t0xff60:0x0061\tNano Pad\n',
      stderr: '',
    });
    fakes.hid.devices.length = 0;
    page = devices.create();
    assert.deepEqual(await hid('list'), {
      status: 0,
      stdout: 'no granted HID devices\n',
      stderr: '',
    });
  });

  it('requests with a typed activation, opens, sends, gets a feature and closes', async () => {
    const probe = new FakeHIDDevice(
      {
        vendorId: 0x1234,
        productId: 0x5678,
        productName: 'Probe',
        collections: [{ usagePage: 0xff00, usage: 1 }],
      },
      { feature: new Uint8Array([0xbe, 0xef]) }
    );
    fakes.hid.devices.length = 0;
    fakes.hid.choose = () => probe;
    fakes = install(globalThis.navigator, {
      hid: fakes.hid,
      userActivation: { isActive: true },
    });
    page = devices.create();
    assert.deepEqual(await run(['hid', 'request', '--vid', '0x1234'], { tags: [typist] }), {
      status: 0,
      stdout: 'hid1\t0x1234:0x5678\t0xff00:0x0001\tProbe\n',
      stderr: '',
    });
    assert.deepEqual(await hid('open', 'hid1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await run(['hid', 'send', 'hid1', '0'], { stdin: '\x01\x02' }), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    assert.deepEqual(await hid('feature-get', 'hid1', '3'), {
      status: 0,
      stdout: 'be ef\n',
      stderr: '',
    });
    assert.deepEqual(await hid('close', 'hid1'), { status: 0, stdout: '', stderr: '' });
  });

  it('refuses root-only ops for a plugdev member without sudo', async () => {
    const result = await run(['hid', 'send', 'hid1', '0'], { user: 'cone', stdin: '\x01' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hid\.send is not allowed for this user/);
  });

  it("says when seven's page does not answer", async () => {
    const alone = await createNodeAlone();
    try {
      const result = await alone.kernel.run(['hid', 'list'], { cwd: '/tmp' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs seven's page \(no page answers hid\.list\)/);
    } finally {
      alone.close();
    }
  });

  it('watches until ^C and exits 130 with no error line', async () => {
    await hid('open', 'hid1');
    const watching = await terminal(['hid', 'watch', 'hid1']);
    await sleep(200);
    device.input(1, new Uint8Array([1, 2]));
    await watching.until(/01 01 02\r\n/);
    watching.term.write('\x03');
    assert.equal(await watching.term.exited, 130);
    assert.doesNotMatch(watching.output(), /hid:/);
  });

  it('queries a closed device through one shared open', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    fresh({ gate, onOpen: () => started() });
    const send = device.sendReport.bind(device);
    device.sendReport = async (reportId, data) => {
      await send(reportId, data);
      device.input(0, new Uint8Array([9, 8]));
    };
    const querying = run(['hid', 'query', 'hid1', '0', '--timeout', '1000'], { stdin: '\x01' });
    await entered;
    release();
    assert.deepEqual(await querying, {
      status: 0,
      stdout: '00 09 08\n',
      stderr: '',
    });
    assert.equal(device.calls.filter(([name]) => name === 'open').length, 1);
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
