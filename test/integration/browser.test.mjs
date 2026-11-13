import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rows as esptoolRows } from './esptool-scenarios.mjs';
import { rows } from './scenarios.mjs';

const skip = process.env.CI ? false : 'runs a real Chrome on CI only';
const root = resolve(import.meta.dirname, '../..');

function files() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const own = ['package.json', ...readdirSync(join(root, 'bin')).map((name) => `bin/${name}`)];
  return own.map((rel) => [`/repo/${rel}`, `/node_modules/${pkg.name}/${rel}`]);
}

async function scenario(set, name) {
  const load = (path) => import(new URL(path, location.href).href);
  const devices = await load('/page/index.mjs');
  const fake = await load('/test/fake-devices.mjs');
  const esp = await load('/test/fake-esp.mjs');
  const tool = await load('/page/esptool.mjs');
  const { rows } = await load(`/test/${set}.mjs`);
  return rows[name].run({ devices, fake, esp, tool });
}

describe('in Chrome', { skip }, () => {
  let chrome;

  before(async () => {
    const { launch } = await import('@ai-ecoverse/slicc-shared-web/harness');
    chrome = await launch({
      roots: [
        ['/kernel/', 'node_modules/@ai-ecoverse/slicc-kernel/dist/'],
        ['/repo/', './'],
        ['/page/', 'page/'],
        ['/esptool-js/', 'node_modules/esptool-js/'],
        ['/test/', 'test/integration/'],
        ['/', 'test/integration/browser/'],
      ],
      isolated: true,
      coverage: [],
      timeout: 120000,
    });
  });

  after(() => chrome?.close());

  describe('the page module, with a fake navigator.serial', () => {
    for (const [name, row] of Object.entries(rows)) {
      it(row.title, async (t) => {
        const tab = await chrome.page(t);
        await tab.goto('/');
        assert.deepEqual(await tab.evaluate(scenario, 'scenarios', name), row.expected, name);
      });
    }
  });

  describe('esptool on esptool-js from the installed package, with a fake ESP ROM loader', () => {
    for (const [name, row] of Object.entries(esptoolRows)) {
      it(row.title, async (t) => {
        const tab = await chrome.page(t);
        await tab.goto('/');
        assert.deepEqual(
          await tab.evaluate(scenario, 'esptool-scenarios', name),
          row.expected,
          name
        );
      });
    }
  });

  it('runs esptool end to end: the command, /dev/embedder, the page module, esptool-js and the fake', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    await tab.until(() => typeof window.boot === 'function');
    assert.equal(await tab.evaluate((list) => window.boot(list), files()), true);
    await tab.evaluate(() => {
      window.serial.board();
    });
    const result = await tab.evaluate(() =>
      window.serial.run(['esptool', '-p', 'serial2', 'read-mac'], {})
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'MAC: 24:0a:c4:12:34:56\n');
    assert.match(result.stderr, /esptool: Hard resetting via RTS pin\.\.\.\n$/);
  });

  it('backs /dev/ttyUSB0 and its by-id link with a granted fake port, in the page', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    await tab.until(() => typeof window.boot === 'function');
    assert.equal(await tab.evaluate((list) => window.boot(list), files()), true);
    await tab.evaluate(() => {
      window.serial.bridge();
    });
    await tab.until(() => window.serial.ports.list().some((port) => port.node === '/dev/ttyUSB0'));
    const run = (argv) => tab.evaluate((a) => window.serial.run(a, {}), argv);
    const stat = await run([
      'ttyprobe',
      'stat',
      '/dev/ttyUSB0',
      '/dev/serial/by-id/usb-0403_6001-if00',
    ]);
    assert.equal(stat.status, 0, stat.stderr);
    assert.deepEqual(JSON.parse(stat.stdout), {
      mode: '20640',
      uid: 0,
      gid: 20,
      link: '../../ttyUSB0',
    });
    assert.deepEqual(await run(['ttyprobe', 'read', '/dev/serial/by-id/usb-0403_6001-if00', '5']), {
      status: 0,
      stdout: '"hello"\n',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'list']), {
      status: 0,
      stdout: 'serial1\t0x2e8a:0x0005\t/dev/ttyACM0\nserial2\t0x0403:0x6001\t/dev/ttyUSB0\n',
      stderr: '',
    });
  });

  it('runs serial end to end: the command, /dev/embedder, the page module and the fake', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    await tab.until(() => typeof window.boot === 'function');
    assert.equal(await tab.evaluate((list) => window.boot(list), files()), true);
    const run = (argv, options) =>
      tab.evaluate((a, o) => window.serial.run(a, o), argv, options ?? {});
    assert.deepEqual(await run(['serial', 'list']), {
      status: 0,
      stdout: 'serial1\t0x2e8a:0x0005\t/dev/ttyACM0\n',
      stderr: '',
    });
    await tab.press('Enter');
    assert.deepEqual(await tab.evaluate(() => window.serial.requested), {
      status: 0,
      stdout: 'serial2\t0x303a:0x1001\t/dev/ttyACM1\n',
      stderr: '',
    });
    assert.deepEqual(
      await tab.evaluate(() => ({
        calls: window.serial.serial.calls.filter(([name]) => name === 'requestPort'),
        prompts: window.serial.hook.prompts,
      })),
      { calls: [['requestPort', { filters: [{ usbVendorId: 0x303a }] }, true]], prompts: [] }
    );
    assert.deepEqual(await run(['serial', 'open', 'serial2', '--baud', '115200']), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'write', 'serial2'], { stdin: 'hello\n' }), {
      status: 0,
      stdout: '6 bytes written\n',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'read', 'serial2', '--until', '0a']), {
      status: 0,
      stdout: 'hello\n',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'list']), {
      status: 0,
      stdout: 'serial1\t0x2e8a:0x0005\t/dev/ttyACM0\nserial2\t0x303a:0x1001 [open]\t/dev/ttyACM1\n',
      stderr: '',
    });
    assert.deepEqual(await run(['serial', 'close', 'serial2']), {
      status: 0,
      stdout: '',
      stderr: '',
    });
  });
});
