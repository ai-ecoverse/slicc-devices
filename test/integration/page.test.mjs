import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import * as tool from '../../page/esptool.mjs';
import { rows as esptoolRows } from './esptool-scenarios.mjs';
import * as fake from './fake-devices.mjs';
import * as esp from './fake-esp.mjs';
import { boot } from './kernel.mjs';
import { rows } from './scenarios.mjs';

const ask = (header) =>
  `exec 3<>/dev/embedder; printf '%s\\n' '${JSON.stringify(header)}' >&3; cat <&3`;
let os;
let hook;
let page = devices.create();
let fakes;

before(async () => {
  hook = fake.embedder(() => page, { 'serial.nope': {} });
  os = await boot({ requests: hook });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  hook.requests.length = 0;
  fakes = fake.install(globalThis.navigator);
  page = devices.create();
});

describe('the page module in Node', () => {
  for (const [name, row] of Object.entries(rows)) {
    it(row.title, async () => {
      assert.deepEqual(await row.run({ devices, fake }), row.expected, name);
    });
  }
});

describe('esptool in Node, with a fake ESP ROM loader behind the fake port', () => {
  for (const [name, row] of Object.entries(esptoolRows)) {
    it(row.title, async () => {
      assert.deepEqual(await row.run({ devices, fake, esp, tool }), row.expected, name);
    });
  }
});

describe('behind /dev/embedder', () => {
  it('reaches the program as ENOTSUP for a kind the hook lists and the page does not know', async () => {
    const result = await os.sh(ask({ kind: 'serial.nope', handle: 'serial1' }));
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr:
        'cat: /dev/embedder: slicc-devices does not answer serial.nope\ncat: -: Not supported\n',
    });
    assert.deepEqual(
      hook.requests.map(({ kind, options, stamp }) => [kind, options, stamp.uid]),
      [['serial.nope', { handle: 'serial1' }, 0]]
    );
  });

  it('answers serial.list with JSON and no trailing newline', async () => {
    fakes.serial.ports.push(new fake.FakeSerialPort({ usbVendorId: 0x2e8a, usbProductId: 5 }));
    const result = await os.sh(ask({ kind: 'serial.list' }));
    assert.deepEqual(result, {
      status: 0,
      stdout: '[{"handle":"serial1","usbVendorId":11914,"usbProductId":5,"open":false}]',
      stderr: '',
    });
  });

  it('never reaches the page for a kind the hook does not list', async () => {
    const result = await os.sh(ask({ kind: 'serial.other' }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^cat: \/dev\/embedder: this embedder does not answer serial\.other$/m
    );
    assert.deepEqual(hook.requests, []);
  });
});
