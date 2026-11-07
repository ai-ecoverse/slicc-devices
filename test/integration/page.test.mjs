import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import page, { create, handle, kinds } from '@ai-ecoverse/slicc-devices/page';
import { embedder, errno, install, request } from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const ask = (header) =>
  `exec 3<>/dev/embedder; printf '%s\\n' '${JSON.stringify(header)}' >&3; cat <&3`;
let os;
let hook;
let fakes;

before(async () => {
  hook = embedder(page, { 'serial.nope': {} });
  os = await boot({ requests: hook });
});

after(() => {
  os?.close();
});

beforeEach(() => {
  hook.requests.length = 0;
  fakes = install(globalThis.navigator);
});

describe('the page module', () => {
  it('exports kinds, handle, create and a default of kinds and handle', () => {
    assert.deepEqual(kinds, {});
    assert.equal(page.kinds, kinds);
    assert.equal(page.handle, handle);
    const other = create();
    assert.equal(other.kinds, kinds);
    assert.equal(typeof other.handle, 'function');
  });

  it('answers a kind it does not know with a NotSupportedError, ENOTSUP', async () => {
    await assert.rejects(handle(request('serial.nope')), (error) => {
      assert.equal(error.name, 'NotSupportedError');
      assert.equal(error.message, 'slicc-devices does not answer serial.nope');
      assert.equal(errno(error), 'ENOTSUP');
      return true;
    });
    assert.deepEqual(fakes.serial.calls, []);
  });
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

  it('never reaches the page for a kind the hook does not list', async () => {
    const result = await os.sh(ask({ kind: 'serial.list' }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^cat: \/dev\/embedder: this embedder does not answer serial\.list$/m
    );
    assert.deepEqual(hook.requests, []);
  });
});
