import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as devices from '@ai-ecoverse/slicc-devices/page';
import { embedder, FakeMIDI, FakeMIDIPort, install } from './fake-devices.mjs';
import { boot } from './kernel.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let os;
let hook;
let page = devices.create();
let fakes;
let input;
let output;
let gesture;

function fresh(extra = {}) {
  input = new FakeMIDIPort({
    id: 'in-1',
    type: 'input',
    name: 'IAC Driver Bus 1',
    manufacturer: 'Apple',
  });
  output = new FakeMIDIPort({
    id: 'out-1',
    type: 'output',
    name: 'IAC Driver Bus 1',
    manufacturer: 'Apple',
  });
  const midi = new FakeMIDI({ inputs: [input], outputs: [output], ...extra });
  fakes = install(globalThis.navigator, { midi });
  page = devices.create();
}

const run = (argv, options = {}) => os.kernel.run(argv, { cwd: '/tmp', ...options });
const midi = (...args) => run(['midi', ...args]);

async function terminal(argv, options = {}) {
  let outputText = '';
  const term = await os.kernel.openTerminal(argv, {
    cwd: '/tmp',
    onData: (data) => {
      outputText += new TextDecoder().decode(data);
    },
    ...options,
  });
  return {
    term,
    output: () => outputText,
    until: async (pattern) => {
      for (let i = 0; i < 400 && !pattern.test(outputText); i++) await sleep(10);
      assert.match(outputText, pattern);
    },
  };
}

before(async () => {
  hook = embedder(() => page, {}, { gesture: (...args) => gesture(...args) });
  os = await boot({ requests: hook });
  await os.kernel.groups.add('audio', { gid: 29 });
  await os.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await os.kernel.groups.addMember('audio', 'cone');
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

describe('midi on the kernel, with a fake navigator.requestMIDIAccess', () => {
  it('prints its help and version', async () => {
    assert.match((await midi()).stdout, /^midi - access MIDI ports via Web MIDI\n/);
    assert.deepEqual(await midi('--version'), {
      status: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
  });

  it('lists nothing until request, then prints ports', async () => {
    assert.deepEqual(await midi('list'), {
      status: 0,
      stdout: '',
      stderr: 'midi: no MIDI ports (midi request)\n',
    });
    assert.deepEqual(await run(['midi', 'request'], { tags: [typist] }), {
      status: 0,
      stdout: 'midi1\tin\tApple IAC Driver Bus 1\nmidi2\tout\tApple IAC Driver Bus 1\n',
      stderr: "midi: waiting for the browser's MIDI permission prompt in seven's tab\n",
    });
    assert.deepEqual(await midi('list'), {
      status: 0,
      stdout: 'midi1\tin\tApple IAC Driver Bus 1\nmidi2\tout\tApple IAC Driver Bus 1\n',
      stderr: '',
    });
  });

  it('opens, sends hex, receives until count, and closes', async () => {
    await run(['midi', 'request'], { tags: [typist] });
    assert.deepEqual(await midi('open', 'midi2'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(await run(['midi', 'send', 'midi2', '--hex', '90', '3c', '7f']), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    assert.deepEqual(
      output.sent.map(({ bytes }) => [...bytes]),
      [[0x90, 0x3c, 0x7f]]
    );
    const receiving = run(['midi', 'receive', 'midi1', '--count', '1']);
    await sleep(50);
    input.input(new Uint8Array([0x80, 0x3c, 0x40]), 1);
    assert.deepEqual(await receiving, {
      status: 0,
      stdout: '80 3c 40\n',
      stderr: '',
    });
    assert.deepEqual(await midi('close', 'midi2'), { status: 0, stdout: '', stderr: '' });
  });

  it('refuses root-only send for an audio member without sudo', async () => {
    await run(['midi', 'request'], { tags: [typist] });
    const result = await run(['midi', 'send', 'midi2', '--hex', '90 3c 7f'], { user: 'cone' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /midi\.send is not allowed for this user/);
  });

  it('rejects malformed send bytes before asking the page', async () => {
    await run(['midi', 'request'], { tags: [typist] });
    const result = await run(['midi', 'send', 'midi2', '--hex', '90 3c']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed MIDI message at offset 0: truncated/);
  });

  it("says when seven's page does not answer", async () => {
    const alone = await createNodeAlone();
    try {
      const result = await alone.kernel.run(['midi', 'list'], { cwd: '/tmp' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs seven's page \(no page answers midi\.list\)/);
    } finally {
      alone.close();
    }
  });

  it('receives until ^C and exits 130 with no error line', async () => {
    await run(['midi', 'request'], { tags: [typist] });
    const receiving = await terminal(['midi', 'receive', 'midi1']);
    await sleep(200);
    input.input(new Uint8Array([0x90, 0x3c, 0x7f]), 1);
    await receiving.until(/90 3c 7f\r\n/);
    receiving.term.write('\x03');
    assert.equal(await receiving.term.exited, 130);
    assert.doesNotMatch(receiving.output(), /midi:/);
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
