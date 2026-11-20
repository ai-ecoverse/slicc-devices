import { HALT_BUSY_MS, SEND_AHEAD_MS } from '../../page/midi.mjs';

const agent = {
  pid: 7,
  uid: 1000,
  gid: 1000,
  tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
};
const typist = {
  pid: 8,
  uid: 0,
  gid: 0,
  tag: JSON.stringify({ kind: 'user', where: 'terminal:1' }),
};

const LIMIT = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const busy = {
  name: 'NoModificationAllowedError',
  message: 'another receive is in progress on midi1',
  errno: 'EBUSY',
};

async function whenListening(port, limit = 400) {
  for (let i = 0; i < limit && !port.listening; i++) await sleep(10);
  if (!port.listening) throw new Error('receive listener did not attach');
}

async function whenCall(target, name, limit = 400) {
  for (let i = 0; i < limit && !target.calls.some(([call]) => call === name); i++) await sleep(10);
  if (!target.calls.some(([call]) => call === name)) throw new Error(`${name} was not called`);
}

async function whenClosed(port, limit = 400) {
  for (let i = 0; i < limit && (port.connection !== 'closed' || port.listening); i++)
    await sleep(10);
}

async function whenEvents(events, match, limit = 400) {
  for (let i = 0; i < limit && !match(events); i++) await sleep(10);
  if (!match(events)) throw new Error('watch events did not arrive');
}

function ports(fake, extra = {}) {
  const input = new fake.FakeMIDIPort({
    id: 'in-1',
    type: 'input',
    name: 'IAC Driver Bus 1',
    manufacturer: 'Apple',
  });
  const output = new fake.FakeMIDIPort({
    id: 'out-1',
    type: 'output',
    name: 'IAC Driver Bus 1',
    manufacturer: 'Apple',
  });
  return { input, output, ...extra };
}

function world(
  { devices, fake },
  { inputs, outputs, grant = true, sysexGrant = true, enabled, gate, onRequest } = {}
) {
  const midi = new fake.FakeMIDI({
    inputs: inputs ?? [ports(fake).input],
    outputs: outputs ?? [ports(fake).output],
    grant,
    sysexGrant,
    gate,
    onRequest,
  });
  const navigator = {
    requestMIDIAccess: (options) => midi.requestAccess(options ?? {}),
  };
  const overrides = { navigator };
  if (enabled) overrides.midiEnabled = enabled;
  const page = devices.create(overrides);
  const lines = [];
  const ask = (kind, options = {}, fields = {}) =>
    page.handle(fake.request(kind, options, { progress: (line) => lines.push(line), ...fields }));
  return { page, midi, navigator, lines, ask };
}

async function caught(promise, fake) {
  try {
    await promise;
    return null;
  } catch (error) {
    return { name: error.name, message: error.message, errno: fake.errno(error) };
  }
}

async function reply(promise, fake) {
  try {
    return { text: await fake.drain(await promise) };
  } catch (error) {
    return { name: error.name, message: error.message, errno: fake.errno(error) };
  }
}

function gated(fake, info = {}, opts = {}) {
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const port = new fake.FakeMIDIPort(info, { gate, onOpen: () => started(), ...opts });
  return { port, release, entered };
}

function gatedClose(fake, info = {}) {
  let release;
  let started;
  const closeGate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const port = new fake.FakeMIDIPort(info, {
    closeGate,
    onOpen: () => {},
  });
  const realClose = port.close.bind(port);
  port.close = async () => {
    started();
    return realClose();
  };
  return { port, release, entered };
}

export const rows = {
  listBeforeRequest: {
    title: 'list before request is an empty array, not an error',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      const got = await reply(ask('midi.list'), fake);
      return { text: got.text, errno: got.errno ?? null };
    },
    expected: { text: '[]', errno: null },
  },
  requestAndList: {
    title: 'request grants access and list returns input and output with separate handles',
    async run(deps) {
      const { fake } = deps;
      const { ask, lines } = world(deps);
      const first = await reply(ask('midi.request', {}, { stamp: agent }), fake);
      const listed = JSON.parse((await reply(ask('midi.list'), fake)).text);
      return {
        lines,
        ports: JSON.parse(first.text).map(({ handle, id, type, name }) => ({
          handle,
          id,
          type,
          name,
        })),
        listed: listed.map(({ handle, id, type }) => ({ handle, id, type })),
      };
    },
    expected: {
      lines: ["waiting for the browser's MIDI permission prompt in seven's tab"],
      ports: [
        { handle: 'midi1', id: 'in-1', type: 'input', name: 'IAC Driver Bus 1' },
        { handle: 'midi2', id: 'out-1', type: 'output', name: 'IAC Driver Bus 1' },
      ],
      listed: [
        { handle: 'midi1', id: 'in-1', type: 'input' },
        { handle: 'midi2', id: 'out-1', type: 'output' },
      ],
    },
  },
  requestProgressOnce: {
    title: 'request sends the permission progress line once before requestMIDIAccess',
    async run(deps) {
      const { fake } = deps;
      const { ask, lines, midi } = world(deps);
      await reply(ask('midi.request', {}, { stamp: agent }), fake);
      return { lines, calls: midi.calls.length };
    },
    expected: {
      lines: ["waiting for the browser's MIDI permission prompt in seven's tab"],
      calls: 1,
    },
  },
  requestSysex: {
    title: 'request --sysex sets sysexEnabled on the access',
    async run(deps) {
      const { fake } = deps;
      const { ask, midi } = world(deps);
      await reply(ask('midi.request', { sysex: true }, { stamp: typist }), fake);
      return { sysex: midi.access.sysexEnabled, calls: midi.calls };
    },
    expected: {
      sysex: true,
      calls: [['requestMIDIAccess', { sysex: true }]],
    },
  },
  requestRefused: {
    title: 'a dismissed MIDI permission is EACCES',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps, { grant: false });
      return caught(ask('midi.request', {}, { stamp: typist }), fake);
    },
    expected: {
      name: 'NotAllowedError',
      message: 'MIDI access was refused in the browser',
      errno: 'EACCES',
    },
  },
  missing: {
    title: 'no requestMIDIAccess is ENOTSUP',
    async run(deps) {
      const { devices, fake } = deps;
      const page = devices.create({ navigator: {} });
      return caught(page.handle(fake.request('midi.list')), fake);
    },
    expected: {
      name: 'NotSupportedError',
      message: 'this browser has no Web MIDI (use Chrome, Edge or Opera on a desktop)',
      errno: 'ENOTSUP',
    },
  },
  openClose: {
    title: 'open and close toggle connection and the live list',
    async run(deps) {
      const { fake } = deps;
      const { ask, page } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) => events.push(event.type));
      await ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      const open = page.devices.midi.list().find((p) => p.handle === 'midi1');
      await ask('midi.close', { handle: 'midi1' }, { stamp: typist });
      const closed = page.devices.midi.list().find((p) => p.handle === 'midi1');
      return {
        events,
        open: open?.connection,
        closed: closed?.connection,
      };
    },
    expected: { events: ['open', 'close'], open: 'open', closed: 'closed' },
  },
  receiveAndSend: {
    title: 'receive streams framed messages; send validates and delivers bytes',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, midi } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const stop = new AbortController();
      const stream = await ask(
        'midi.receive',
        { handle: 'midi1' },
        { stamp: typist, signal: stop.signal }
      );
      const reader = stream.getReader();
      await whenListening(input);
      input.input(new Uint8Array([0x90, 0x3c, 0x7f]), 12.5);
      const { value: frame } = await reader.read();
      stop.abort();
      await reader.cancel().catch(() => {});
      await ask(
        'midi.send',
        { handle: 'midi2' },
        { stamp: typist, body: fake.bytes(new Uint8Array([0x80, 0x3c, 0x40])) }
      );
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      return {
        parsed: {
          timestamp: view.getFloat64(0, true),
          length: view.getUint32(8, true),
          bytes: [...frame.subarray(12)],
        },
        sent: midi.access.outputs.get('out-1').sent.map(({ bytes }) => [...bytes]),
      };
    },
    expected: {
      parsed: { timestamp: 12.5, length: 3, bytes: [0x90, 0x3c, 0x7f] },
      sent: [[0x80, 0x3c, 0x40]],
    },
  },
  oneReceiver: {
    title: 'a second receive on the same input is EBUSY',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      const first = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      const second = await caught(
        ask('midi.receive', { handle: 'midi1' }, { stamp: typist }),
        fake
      );
      await first.getReader().cancel();
      return second;
    },
    expected: {
      name: 'NoModificationAllowedError',
      message: 'another receive is in progress on midi1',
      errno: 'EBUSY',
    },
  },
  wrongType: {
    title: 'receive on an output and send on an input are TypeErrors',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      const receive = await caught(
        ask('midi.receive', { handle: 'midi2' }, { stamp: typist }),
        fake
      );
      const send = await caught(
        ask(
          'midi.send',
          { handle: 'midi1' },
          { stamp: typist, body: fake.bytes(new Uint8Array([0x90, 0x3c, 0x7f])) }
        ),
        fake
      );
      return {
        receive: { name: receive.name, message: receive.message },
        send: { name: send.name, message: send.message },
      };
    },
    expected: {
      receive: {
        name: 'TypeError',
        message: 'midi2 is an output (midi receive needs an input)',
      },
      send: {
        name: 'TypeError',
        message: 'midi1 is an input (midi send needs an output)',
      },
    },
  },
  sysexRefused: {
    title: 'sending sysex without sysex access is EACCES naming midi request --sysex',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      return caught(
        ask(
          'midi.send',
          { handle: 'midi2' },
          { stamp: typist, body: fake.bytes(new Uint8Array([0xf0, 0x01, 0xf7])) }
        ),
        fake
      );
    },
    expected: {
      name: 'NotAllowedError',
      message: 'sysex needs midi request --sysex',
      errno: 'EACCES',
    },
  },
  sendLimit: {
    title: 'a send over 64 KiB is refused before anything is sent',
    async run(deps) {
      const { fake } = deps;
      const { ask, midi } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      const big = new Uint8Array(LIMIT + 1);
      big[0] = 0xf8;
      for (let i = 1; i < big.length; i++) big[i] = 0xf8;
      const refused = await caught(
        ask('midi.send', { handle: 'midi2' }, { stamp: typist, body: fake.bytes(big) }),
        fake
      );
      return {
        refused: { name: refused.name, message: refused.message },
        sent: midi.access.outputs.get('out-1').sent.length,
      };
    },
    expected: {
      refused: { name: 'QuotaExceededError', message: 'a MIDI send is at most 64 KiB' },
      sent: 0,
    },
  },
  malformed: {
    title: 'a truncated message fails with the offset',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      return caught(
        ask(
          'midi.send',
          { handle: 'midi2' },
          { stamp: typist, body: fake.bytes(new Uint8Array([0x90, 0x3c])) }
        ),
        fake
      );
    },
    expected: {
      name: 'TypeError',
      message: 'malformed MIDI message at offset 0: truncated',
      errno: 'EIO',
    },
  },
  unplugReceive: {
    title: 'unplug during a receive ends with EIO',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, midi } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const stream = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      const pending = reply(fake.collect(stream), fake);
      await whenListening(input);
      midi.access.unplug(input);
      return pending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'midi1 was unplugged',
      errno: 'EIO',
    },
  },
  unplugSend: {
    title: 'unplug during a send ends with EIO',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      let release;
      let started;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        started = resolve;
      });
      const realSend = output.send.bind(output);
      output.send = async (data, timestamp) => {
        started();
        await gate;
        return realSend(data, timestamp);
      };
      const { ask, midi } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      await ask('midi.open', { handle: 'midi2' }, { stamp: typist });
      const sending = caught(
        ask(
          'midi.send',
          { handle: 'midi2' },
          { stamp: typist, body: fake.bytes(new Uint8Array([0x90, 0x3c, 0x7f])) }
        ),
        fake
      );
      await entered;
      midi.access.unplug(output);
      release();
      return sending;
    },
    expected: {
      name: 'InvalidStateError',
      message: 'midi2 was unplugged',
      errno: 'EIO',
    },
  },
  replug: {
    title: 're-plug keeps the handle keyed by port id',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, page, midi } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      await ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      await ask('midi.close', { handle: 'midi1' }, { stamp: typist });
      midi.access.unplug(input);
      const again = new fake.FakeMIDIPort({
        id: 'in-1',
        type: 'input',
        name: 'IAC Driver Bus 1',
        manufacturer: 'Apple',
      });
      midi.access.plug(again);
      const listed = JSON.parse((await reply(ask('midi.list'), fake)).text);
      return {
        input: listed.find((p) => p.type === 'input'),
        handles: page.devices.midi.list().map((p) => p.handle),
      };
    },
    expected: {
      input: {
        handle: 'midi1',
        id: 'in-1',
        type: 'input',
        name: 'IAC Driver Bus 1',
        manufacturer: 'Apple',
        state: 'connected',
        connection: 'closed',
      },
      handles: ['midi1', 'midi2'],
    },
  },
  closeDuringOpen: {
    title: 'midi.close during a pending open leaves the port closed',
    async run(deps) {
      const { fake } = deps;
      const { port, release, entered } = gated(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const { ask, page } = world(deps, { inputs: [port], outputs: [] });
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) => events.push(event.type));
      const opening = ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      await entered;
      const closing = ask('midi.close', { handle: 'midi1' }, { stamp: typist });
      release();
      const refused = await caught(opening, fake);
      await closing;
      return {
        refused,
        connection: port.connection,
        listed: page.devices.midi.list()[0].connection,
        opened: events.includes('open'),
      };
    },
    expected: {
      refused: {
        name: 'InvalidStateError',
        message: 'midi1 is not open (midi open midi1)',
        errno: 'EIO',
      },
      connection: 'closed',
      listed: 'closed',
      opened: false,
    },
  },
  switchDuringOpen: {
    title: 'closeAll during a pending open fails it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const { port, release, entered } = gated(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const midi = new fake.FakeMIDI({ inputs: [port], outputs: [] });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
        midiEnabled: () => on,
      });
      await page.handle(fake.request('midi.request', {}, { stamp: typist }));
      const opening = page.handle(
        fake.request('midi.open', { handle: 'midi1' }, { stamp: typist })
      );
      await entered;
      on = false;
      await page.devices.midi.closeAll();
      release();
      const refused = await caught(opening, fake);
      const later = await caught(page.handle(fake.request('midi.list')), fake);
      return { refused, later };
    },
    expected: {
      refused: {
        name: 'NotAllowedError',
        message: "MIDI devices are off in seven's settings",
        errno: 'EACCES',
      },
      later: {
        name: 'NotAllowedError',
        message: "MIDI devices are off in seven's settings",
        errno: 'EACCES',
      },
    },
  },
  switchDuringReceive: {
    title: 'closeAll during a receive ends it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const { input, output } = ports(fake);
      const midi = new fake.FakeMIDI({ inputs: [input], outputs: [output] });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
        midiEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('midi.request');
      const stream = await ask('midi.receive', { handle: 'midi1' });
      const pending = reply(fake.collect(stream), fake);
      await whenListening(input);
      on = false;
      await page.devices.midi.closeAll();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "MIDI devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  switchDuringRequest: {
    title: 'closeAll during a pending requestMIDIAccess fails it with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const midi = new fake.FakeMIDI({
        inputs: [ports(fake).input],
        outputs: [ports(fake).output],
        gate,
      });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
        midiEnabled: () => on,
      });
      const pending = caught(
        page.handle(fake.request('midi.request', {}, { stamp: typist })),
        fake
      );
      await whenCall(midi, 'requestMIDIAccess');
      on = false;
      await page.devices.midi.closeAll();
      release();
      return pending;
    },
    expected: {
      name: 'NotAllowedError',
      message: "MIDI devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  switchDuringReceiveOpen: {
    title: 'closeAll during a pending receive open fails the stream with the switch off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const { port, release, entered } = gated(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const midi = new fake.FakeMIDI({ inputs: [port], outputs: [] });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
        midiEnabled: () => on,
      });
      await page.handle(fake.request('midi.request', {}, { stamp: typist }));
      const pending = page.handle(
        fake.request('midi.receive', { handle: 'midi1' }, { stamp: typist })
      );
      await entered;
      on = false;
      await page.devices.midi.closeAll();
      release();
      return reply(fake.drain(await pending), fake);
    },
    expected: {
      name: 'NotAllowedError',
      message: "MIDI devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  reopenAfterCancel: {
    title: 'midi.open after close during a pending open succeeds',
    async run(deps) {
      const { fake } = deps;
      const { port, release, entered } = gated(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const { ask, page } = world(deps, { inputs: [port], outputs: [] });
      await ask('midi.request', {}, { stamp: typist });
      const first = ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      await entered;
      await ask('midi.close', { handle: 'midi1' }, { stamp: typist });
      const second = ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      release();
      const refused = await caught(first, fake);
      await second;
      return {
        refused,
        connection: port.connection,
        listed: page.devices.midi.list()[0].connection,
        opens: port.calls.filter(([name]) => name === 'open').length,
      };
    },
    expected: {
      refused: {
        name: 'InvalidStateError',
        message: 'midi1 is not open (midi open midi1)',
        errno: 'EIO',
      },
      connection: 'open',
      listed: 'open',
      opens: 2,
    },
  },
  off: {
    title: 'the MIDI switch refuses every kind when off',
    async run(deps) {
      const { devices, fake } = deps;
      const page = devices.create({
        navigator: {
          requestMIDIAccess: () =>
            Promise.resolve(new fake.FakeMIDIAccess({ inputs: [], outputs: [] })),
        },
        midiEnabled: () => false,
      });
      return caught(page.handle(fake.request('midi.list')), fake);
    },
    expected: {
      name: 'NotAllowedError',
      message: "MIDI devices are off in seven's settings",
      errno: 'EACCES',
    },
  },
  receiveSlotBusy: {
    title: 'a second receive while an aborted close is still settling is EBUSY',
    async run(deps) {
      const { fake } = deps;
      const { port, release, entered } = gatedClose(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const { ask } = world(deps, { inputs: [port], outputs: [] });
      await ask('midi.request', {}, { stamp: typist });
      const controller = new AbortController();
      const stream = await ask(
        'midi.receive',
        { handle: 'midi1' },
        { stamp: typist, signal: controller.signal }
      );
      await whenListening(port);
      controller.abort();
      await entered;
      const second = await caught(
        ask('midi.receive', { handle: 'midi1' }, { stamp: typist }),
        fake
      );
      release();
      await whenClosed(port);
      const third = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      await third.cancel();
      void stream;
      return { second, third: third instanceof ReadableStream };
    },
    expected: { second: busy, third: true },
  },
  abortDuringOpen: {
    title: 'aborting receive during a pending open leaves the port closed',
    async run(deps) {
      const { fake } = deps;
      const { port, release, entered } = gated(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const { ask } = world(deps, { inputs: [port], outputs: [] });
      await ask('midi.request', {}, { stamp: typist });
      const controller = new AbortController();
      const stream = await ask(
        'midi.receive',
        { handle: 'midi1' },
        { stamp: typist, signal: controller.signal }
      );
      const pending = reply(fake.collect(stream), fake);
      await entered;
      controller.abort();
      release();
      await whenClosed(port);
      await pending;
      const again = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      await again.cancel();
      await whenClosed(port);
      return {
        connection: port.connection,
        listening: port.listening,
        again: again instanceof ReadableStream,
      };
    },
    expected: {
      connection: 'closed',
      listening: false,
      again: true,
    },
  },
  closeAllReceiveRace: {
    title: 'closeAll waits out a gated receive close so a concurrent receive stays EBUSY',
    async run(deps) {
      const { devices, fake } = deps;
      const { port, release, entered } = gatedClose(fake, {
        id: 'in-1',
        type: 'input',
        name: 'Pad',
      });
      const midi = new fake.FakeMIDI({ inputs: [port], outputs: [] });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('midi.request');
      const stream = await ask('midi.receive', { handle: 'midi1' });
      await whenListening(port);
      const closing = page.devices.midi.closeAll();
      await entered;
      const racing = await caught(ask('midi.receive', { handle: 'midi1' }), fake);
      release();
      await closing;
      return {
        racing,
        connection: port.connection,
        handler: port.onmidimessage,
        listed: page.devices.midi.list()[0].connection,
      };
    },
    expected: {
      racing: busy,
      connection: 'closed',
      handler: null,
      listed: 'closed',
    },
  },
  sysexUpgradeRetiresPort: {
    title: 'request --sysex while receiving retires the old port before closeAll',
    async run(deps) {
      const { devices, fake } = deps;
      const midi = new fake.FakeMIDI({
        inputs: [{ id: 'in-1', type: 'input', name: 'Pad' }],
        outputs: [],
      });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('midi.request');
      const firstPort = midi.access.inputs.get('in-1');
      const stream = await ask('midi.receive', { handle: 'midi1' });
      await whenListening(firstPort);
      const pending = reply(fake.collect(stream), fake);
      await ask('midi.request', { sysex: true });
      const secondPort = midi.access.inputs.get('in-1');
      await page.devices.midi.closeAll();
      const ended = await pending;
      return {
        same: firstPort === secondPort,
        firstConnection: firstPort.connection,
        firstHandler: firstPort.onmidimessage,
        secondConnection: secondPort.connection,
        ended: { name: ended.name, errno: ended.errno ?? null },
      };
    },
    expected: {
      same: false,
      firstConnection: 'closed',
      firstHandler: null,
      secondConnection: 'closed',
      ended: { name: 'InvalidStateError', errno: 'EIO' },
    },
  },
  timedSendCleared: {
    title: 'a scheduled send is cleared when the switch turns off',
    async run(deps) {
      const { devices, fake } = deps;
      let on = true;
      const { input, output } = ports(fake);
      const midi = new fake.FakeMIDI({ inputs: [input], outputs: [output] });
      const page = devices.create({
        navigator: { requestMIDIAccess: (options) => midi.requestAccess(options ?? {}) },
        midiEnabled: () => on,
      });
      const ask = (kind, options = {}, fields = {}) =>
        page.handle(fake.request(kind, options, { stamp: typist, ...fields }));
      await ask('midi.request');
      await ask('midi.open', { handle: 'midi2' });
      const when = performance.now() + 200;
      await ask(
        'midi.send',
        { handle: 'midi2', timestamp: when },
        { body: fake.bytes(new Uint8Array([0x90, 0x3c, 0x7f])) }
      );
      const queued = output.scheduled.length;
      on = false;
      await page.devices.midi.closeAll();
      while (performance.now() < when + 50) await sleep(10);
      return {
        queued,
        sent: output.sent.length,
        cleared: output.calls.some(([name]) => name === 'clear'),
        connection: output.connection,
        ahead: SEND_AHEAD_MS,
        halt: HALT_BUSY_MS,
      };
    },
    expected: {
      queued: 1,
      sent: 0,
      cleared: true,
      connection: 'closed',
      ahead: 5000,
      halt: 1000,
    },
  },
  receiveAbortPairsClose: {
    title: 'aborting a receive emits a close watch event paired with its open',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, page } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) =>
        events.push(
          event.type === 'open' ? ['open', event.handle] : [event.type, event.handle, event.why]
        )
      );
      const controller = new AbortController();
      const stream = await ask(
        'midi.receive',
        { handle: 'midi1' },
        { stamp: typist, signal: controller.signal }
      );
      await whenListening(input);
      controller.abort();
      await stream.cancel().catch(() => {});
      await whenClosed(input);
      await whenEvents(events, (list) => list.some(([type]) => type === 'close'));
      return { events, connection: input.connection };
    },
    expected: {
      events: [
        ['open', 'midi1'],
        ['close', 'midi1', 'closed'],
      ],
      connection: 'closed',
    },
  },
  receiveCancelPairsClose: {
    title: 'cancelling a receive reader emits a close watch event paired with its open',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, page } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) =>
        events.push(
          event.type === 'open' ? ['open', event.handle] : [event.type, event.handle, event.why]
        )
      );
      const stream = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      await whenListening(input);
      await stream.cancel();
      await whenClosed(input);
      await whenEvents(events, (list) => list.some(([type]) => type === 'close'));
      return { events, connection: input.connection };
    },
    expected: {
      events: [
        ['open', 'midi1'],
        ['close', 'midi1', 'closed'],
      ],
      connection: 'closed',
    },
  },
  receiveCountPairsClose: {
    title: 'ending a receive after one message (as --count 1) pairs open and close',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, page } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) =>
        events.push(
          event.type === 'open' ? ['open', event.handle] : [event.type, event.handle, event.why]
        )
      );
      const stream = await ask('midi.receive', { handle: 'midi1' }, { stamp: typist });
      const reader = stream.getReader();
      await whenListening(input);
      input.input(new Uint8Array([0x90, 0x3c, 0x7f]), 1);
      const { value } = await reader.read();
      await reader.cancel();
      await whenClosed(input);
      await whenEvents(events, (list) => list.some(([type]) => type === 'close'));
      return {
        events,
        got: value ? value.byteLength > 12 : false,
        connection: input.connection,
      };
    },
    expected: {
      events: [
        ['open', 'midi1'],
        ['close', 'midi1', 'closed'],
      ],
      got: true,
      connection: 'closed',
    },
  },
  retireOpenedPairsClose: {
    title: 're-enumeration while opened emits close with why unplugged',
    async run(deps) {
      const { fake } = deps;
      const { input, output } = ports(fake);
      const { ask, page, midi } = world(deps, { inputs: [input], outputs: [output] });
      await ask('midi.request', {}, { stamp: typist });
      const events = [];
      page.devices.midi.watch((event) =>
        events.push(
          event.type === 'open' ? ['open', event.handle] : [event.type, event.handle, event.why]
        )
      );
      await ask('midi.open', { handle: 'midi1' }, { stamp: typist });
      const replacement = new fake.FakeMIDIPort({
        id: 'in-1',
        type: 'input',
        name: 'IAC Driver Bus 1',
        manufacturer: 'Apple',
      });
      midi.access.inputs.set('in-1', replacement);
      replacement.midi = midi.access;
      await ask('midi.list', {}, { stamp: typist });
      await whenEvents(events, (list) =>
        list.some(([type, , why]) => type === 'close' && why === 'unplugged')
      );
      return {
        events,
        same: page.devices.midi.list().find((p) => p.handle === 'midi1')?.connection,
        firstClosed: input.connection,
      };
    },
    expected: {
      events: [
        ['open', 'midi1'],
        ['close', 'midi1', 'unplugged'],
      ],
      same: 'closed',
      firstClosed: 'closed',
    },
  },
  badStatusNoByte: {
    title: 'a bad status error names the offset and not the status byte',
    async run(deps) {
      const { fake } = deps;
      const { ask } = world(deps);
      await ask('midi.request', {}, { stamp: typist });
      return caught(
        ask(
          'midi.send',
          { handle: 'midi2' },
          { stamp: typist, body: fake.bytes(new Uint8Array([0xf4])) }
        ),
        fake
      );
    },
    expected: {
      name: 'TypeError',
      message: 'malformed MIDI message at offset 0: bad status',
      errno: 'EIO',
    },
  },
};
