import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const skip = process.env.CI ? false : 'runs a real Chrome on CI only';

async function probe({ kind }) {
  const fakes = await import(new URL('/test/fake-devices.mjs', location.href).href);
  const installed = fakes.install(navigator);
  const module = await import(new URL('/page/index.mjs', location.href).href);
  const hook = fakes.embedder(module.default, { [kind]: {} });
  const result = {
    kinds: module.kinds,
    shape: [typeof module.handle, typeof module.create, module.default.handle === module.handle],
    listed: Object.keys(hook.kinds),
    fake: navigator.serial === installed.serial,
    ports: (await navigator.serial.getPorts()).length,
  };
  installed.serial.calls.length = 0;
  try {
    await hook.handle(fakes.request(kind, { handle: 'serial1' }));
    result.answered = true;
  } catch (error) {
    result.error = { name: error.name, message: error.message, errno: fakes.errno(error) };
  }
  result.requests = hook.requests.map(({ kind, options }) => [kind, options]);
  result.calls = installed.serial.calls;
  return result;
}

describe('the page module in Chrome', { skip }, () => {
  let chrome;

  before(async () => {
    const { launch } = await import('@ai-ecoverse/slicc-shared-web/harness');
    chrome = await launch({
      roots: [
        ['/page/', 'page/'],
        ['/test/', 'test/integration/'],
        ['/', 'test/integration/browser/'],
      ],
      coverage: [],
    });
  });

  after(() => chrome?.close());

  it('loads with a fake navigator.serial and answers an unknown kind with ENOTSUP', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    const result = await tab.evaluate(probe, { kind: 'serial.nope' });
    assert.deepEqual(result, {
      kinds: {},
      shape: ['function', 'function', true],
      listed: ['serial.nope'],
      fake: true,
      ports: 0,
      error: {
        name: 'NotSupportedError',
        message: 'slicc-devices does not answer serial.nope',
        errno: 'ENOTSUP',
      },
      requests: [['serial.nope', { handle: 'serial1' }]],
      calls: [],
    });
  });
});
