import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeUSBDevice, install, usbConfig } from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });

let os;
let hook;
let page = devices.create();
let fakes;
let device;
let gesture;

function fresh() {
  device = new FakeUSBDevice(
    {
      vendorId: 0x2341,
      productId: 0x0043,
      productName: 'Arduino Uno',
      manufacturerName: 'Arduino LLC',
      serialNumber: 'UNO1',
    },
    {
      configuration: usbConfig(),
      inData: new Uint8Array([0xde, 0xad]),
      controlIn: new Uint8Array([0xbe, 0xef]),
    }
  );
  fakes = install(globalThis.navigator, { userActivation: { isActive: false } });
  fakes.usb.devices.push(fakes.usb.own(device));
  page = devices.create();
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const usb = (...args) => run(['usb', ...args]);

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

describe('usb on the kernel, with a fake navigator.usb', () => {
  it('prints its help and version', async () => {
    assert.match((await usb()).stdout, /^usb - access USB devices via WebUSB\n/);
    assert.deepEqual(await usb('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
  });

  it('lists devices as six does, and says when there are none', async () => {
    assert.deepEqual(await usb('list'), {
      status: 0,
      stdout: 'usb1\t0x2341:0x0043\tArduino LLC Arduino Uno serial=UNO1\n',
      stderr: '',
    });
    fakes.usb.devices.length = 0;
    page = devices.create();
    assert.deepEqual(await usb('list'), {
      status: 0,
      stdout: 'no granted USB devices\n',
      stderr: '',
    });
  });

  it('requests with a typed activation, opens, claims, transfers and closes', async () => {
    const probe = new FakeUSBDevice(
      { vendorId: 0x1234, productId: 0x5678, productName: 'Probe' },
      {
        configuration: usbConfig(),
        inData: new Uint8Array([0xcd, 0xcd]),
      }
    );
    fakes.usb.devices.length = 0;
    fakes.usb.choose = () => probe;
    fakes = install(globalThis.navigator, {
      usb: fakes.usb,
      userActivation: { isActive: true },
    });
    page = devices.create();
    assert.deepEqual(await run(['usb', 'request', '--vid', '0x1234'], { tags: [typist] }), {
      status: 0,
      stdout: 'usb1\t0x1234:0x5678\tProbe\n',
      stderr: '',
    });
    assert.deepEqual(await usb('open', 'usb1'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await usb('claim', 'usb1', '0'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await usb('transfer-in', 'usb1', '1', '2'), {
      status: 0,
      stdout: 'cd cd\n',
      stderr: '',
    });
    assert.deepEqual(await run(['usb', 'transfer-out', 'usb1', '1'], { stdin: '\x01\x02' }), {
      status: 0,
      stdout: '2 bytes written\n',
      stderr: '',
    });
    assert.deepEqual(await usb('close', 'usb1'), { status: 0, stdout: '', stderr: '' });
  });

  it('refuses a second claim naming the holder', async () => {
    await usb('open', 'usb1');
    await usb('claim', 'usb1', '0');
    const second = await run(['usb', 'claim', 'usb1', '0'], { user: 'cone' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /usb1 is claimed by uid:\d+ \(usb claim --wait \.\.\.\)/);
  });

  it('refuses root-only ops for a plugdev member without sudo', async () => {
    await usb('open', 'usb1');
    const result = await run(['usb', 'reset', 'usb1'], { user: 'cone' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usb\.reset is not allowed for this user/);
  });

  it("says when seven's page does not answer", async () => {
    const alone = await createNodeAlone();
    try {
      const result = await alone.kernel.run(['usb', 'list'], { cwd: '/tmp' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs seven's page \(no page answers usb\.list\)/);
    } finally {
      alone.close();
    }
  });
});

describe('usb claim holders through createNodeKernel with users enforce', () => {
  let enforce;
  let enforceHook;
  let enforcePage = devices.create();

  before(async () => {
    enforceHook = embedder(() => enforcePage);
    enforce = await boot({
      users: 'enforce',
      requests: enforceHook,
      approve: () => 'once',
    });
    await enforce.kernel.groups.add('plugdev', { gid: 46 });
    await enforce.kernel.users.add({ name: 'cone', groups: ['sudo', 'plugdev'] });
  });

  after(() => {
    enforce?.close();
  });

  beforeEach(() => {
    enforceHook.requests.length = 0;
    const board = new FakeUSBDevice(
      {
        vendorId: 0x2341,
        productId: 0x0043,
        productName: 'Arduino Uno',
        manufacturerName: 'Arduino LLC',
        serialNumber: 'UNO1',
      },
      { configuration: usbConfig(), inData: new Uint8Array([1]), controlIn: new Uint8Array([2]) }
    );
    const fakes = install(globalThis.navigator);
    fakes.usb.devices.push(fakes.usb.own(board));
    enforcePage = devices.create();
  });

  it('keeps an agent claim across sudo transfer-out, and splits same-uid agents', async () => {
    const { holder } = await import('../../page/usb.mjs');
    const cone = JSON.stringify({ kind: 'agent', agentId: 'cone' });
    const other = JSON.stringify({ kind: 'agent', agentId: 'other' });
    const run = (argv, opts = {}) =>
      enforce.kernel.run(argv, { cwd: '/tmp', user: 'cone', ...opts });
    assert.equal((await run(['usb', 'open', 'usb1'], { tags: [cone] })).status, 0);
    assert.equal((await run(['usb', 'claim', 'usb1', '0'], { tags: [cone] })).status, 0);
    const claim = enforceHook.requests.find((r) => r.kind === 'usb.claim');
    assert.ok(claim.stamp.uid > 0);
    assert.equal(holder(claim.stamp), 'agent:cone');
    enforceHook.requests.length = 0;
    const out = await run(['sudo', 'usb', 'transfer-out', 'usb1', '1'], {
      tags: [cone],
      stdin: '\x01',
    });
    assert.equal(out.status, 0, out.stderr);
    const transfer = enforceHook.requests.find((r) => r.kind === 'usb.transfer.out');
    assert.ok(transfer);
    assert.equal(transfer.stamp.uid, 0);
    assert.equal(holder(transfer.stamp), 'agent:cone');
    assert.equal(holder(claim.stamp), holder(transfer.stamp));
    const second = await run(['usb', 'claim', 'usb1', '0'], { tags: [other] });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /usb1 is claimed by agent:cone \(usb claim --wait \.\.\.\)/);
    assert.notEqual(holder({ tag: other }), holder(claim.stamp));
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
