export const LIMIT = 64 * 1024;
export const RECEIVE_BUFFER = 256;
export const HALT_BUSY_MS = 1000;
export const SEND_AHEAD_MS = 5000;
export const WAITING = "waiting for the browser's MIDI permission prompt in seven's tab";
export const OFF = "MIDI devices are off in seven's settings";
export const MISSING = 'this browser has no Web MIDI (use Chrome, Edge or Opera on a desktop)';
export const REFUSED = 'MIDI access was refused in the browser';
export const SYSEX_NEED = 'sysex needs midi request --sysex';
const QUIET = 250;

const reading = Object.freeze({ group: 'audio', session: false });
const writing = Object.freeze({ session: false });

export const kinds = Object.freeze({
  'midi.list': reading,
  'midi.request': reading,
  'midi.open': reading,
  'midi.close': reading,
  'midi.receive': reading,
  'midi.send': writing,
});

function fail(name, message) {
  return new DOMException(message, name);
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

function parsed(tag) {
  try {
    return JSON.parse(tag);
  } catch {
    return null;
  }
}

function tagsOf(stamp) {
  return [stamp?.tag, ...(stamp?.tags ?? [])].filter((tag) => typeof tag === 'string').map(parsed);
}

export function typed(stamp) {
  const tags = tagsOf(stamp);
  return (
    tags.length > 0 &&
    tags.every(
      (tag) =>
        tag?.kind === 'user' && typeof tag.where === 'string' && tag.where.startsWith('terminal:')
    )
  );
}

export function asker(stamp) {
  const agent = tagsOf(stamp).find((tag) => tag?.kind === 'agent');
  if (!agent) return 'A program';
  return typeof agent.agentId === 'string' ? `The agent ${agent.agentId}` : 'The agent';
}

function aborted(signal) {
  const reason = signal.reason;
  if (reason?.name === 'AbortError') return reason;
  return fail('AbortError', String(reason?.message ?? reason));
}

function race(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

function off(enabled, registry, seen) {
  return !enabled() || registry.epoch !== seen;
}

function refuse() {
  throw fail('NotAllowedError', OFF);
}

function dataLength(status) {
  const high = status & 0xf0;
  if (high === 0xc0 || high === 0xd0) return 1;
  if (high >= 0x80 && high <= 0xe0) return 2;
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  if (status === 0xf6 || status >= 0xf8) return 0;
  return -1;
}

function sysexEnd(bytes, at) {
  let end = at + 1;
  while (end < bytes.byteLength && bytes[end] !== 0xf7) {
    if (bytes[end] >= 0x80)
      throw new TypeError(`malformed MIDI sysex at offset ${at}: status byte inside sysex`);
    end += 1;
  }
  if (end >= bytes.byteLength)
    throw new TypeError(`malformed MIDI sysex at offset ${at}: missing F7`);
  return end + 1;
}

function shortEnd(bytes, at, status) {
  const need = dataLength(status);
  if (need < 0) throw new TypeError(`malformed MIDI message at offset ${at}: bad status`);
  if (at + 1 + need > bytes.byteLength)
    throw new TypeError(`malformed MIDI message at offset ${at}: truncated`);
  for (let i = 1; i <= need; i++) {
    if (bytes[at + i] >= 0x80)
      throw new TypeError(`malformed MIDI message at offset ${at}: data byte has high bit`);
  }
  return at + 1 + need;
}

export function validateMessages(bytes, { sysex = false } = {}) {
  if (!(bytes instanceof Uint8Array)) throw invalid('body', bytes);
  if (bytes.byteLength > LIMIT) throw fail('QuotaExceededError', 'a MIDI send is at most 64 KiB');
  let at = 0;
  while (at < bytes.byteLength) {
    const status = bytes[at];
    if (status < 0x80)
      throw new TypeError(`malformed MIDI message at offset ${at}: missing status byte`);
    if (status === 0xf0) {
      if (!sysex) throw fail('NotAllowedError', SYSEX_NEED);
      at = sysexEnd(bytes, at);
    } else at = shortEnd(bytes, at, status);
  }
  return bytes;
}

function isSysex(bytes) {
  return bytes.byteLength > 0 && bytes[0] === 0xf0;
}

export function frameMessage(timestamp, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(12 + bytes.byteLength);
  new DataView(out.buffer).setFloat64(0, Number(timestamp) || 0, true);
  new DataView(out.buffer).setUint32(8, bytes.byteLength, true);
  out.set(bytes, 12);
  return out;
}

export function readFrame(buffer, offset = 0) {
  if (buffer.byteLength - offset < 12) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
  const timestamp = view.getFloat64(0, true);
  const length = view.getUint32(8, true);
  if (buffer.byteLength - offset < 12 + length) return null;
  return {
    timestamp,
    bytes: buffer.subarray(offset + 12, offset + 12 + length),
    next: offset + 12 + length,
  };
}

function info(entry) {
  const { port, handle } = entry;
  const out = {
    handle,
    id: entry.id,
    type: entry.type,
    name: port.name || '',
    state: entry.gone ? 'disconnected' : port.state || 'connected',
    connection: entry.opened ? 'open' : port.connection || 'closed',
  };
  if (port.manufacturer) out.manufacturer = port.manufacturer;
  return out;
}

function blank(handle, port) {
  return {
    handle,
    port,
    id: port.id,
    type: port.type,
    gone: false,
    opened: false,
    announced: false,
    ended: null,
    closing: null,
    opening: null,
    closes: 0,
    receiving: false,
    haltReceive: null,
    receiveDone: null,
    stopReceive: null,
  };
}

function noteClose(registry, entry, why) {
  if (!entry.announced) return;
  entry.announced = false;
  registry.emit({ type: 'close', handle: entry.handle, why });
}

function retirePreviousPort(registry, entry, next) {
  const old = entry.port;
  if (!old || old === next) {
    entry.port = next;
    return;
  }
  entry.port = next;
  try {
    old.onmidimessage = null;
  } catch {}
  if (old.type === 'output') clearOutput(old);
  void Promise.resolve(old.close()).catch(() => {});
  if (entry.receiving) {
    try {
      entry.stopReceive?.('unplugged');
    } catch {}
  } else if (entry.opened) {
    entry.opened = false;
    noteClose(registry, entry, 'unplugged');
  }
}

function makeRegistry() {
  const entries = new Map();
  const byId = new Map();
  const watchers = new Set();
  let count = 0;
  const registry = {
    entries,
    watchers,
    epoch: 0,
    access: null,
    sysex: false,
    unhear: null,
    emit(event) {
      for (const watcher of watchers) {
        try {
          watcher(event);
        } catch {}
      }
    },
    listed: () => [...entries.values()],
    adopt(port) {
      if (!port?.id) return null;
      let entry = byId.get(port.id);
      if (entry) {
        retirePreviousPort(registry, entry, port);
        entry.gone = port.state === 'disconnected';
        entry.type = port.type;
        return entry;
      }
      count += 1;
      entry = blank(`midi${count}`, port);
      entry.gone = port.state === 'disconnected';
      entries.set(entry.handle, entry);
      byId.set(port.id, entry);
      return entry;
    },
    syncAccess(access) {
      registry.access = access;
      registry.sysex = Boolean(access.sysexEnabled);
      const seen = new Set();
      for (const port of access.inputs.values()) {
        const entry = registry.adopt(port);
        if (entry) seen.add(entry.id);
      }
      for (const port of access.outputs.values()) {
        const entry = registry.adopt(port);
        if (entry) seen.add(entry.id);
      }
      for (const entry of entries.values()) {
        if (!seen.has(entry.id) && !entry.opened && !entry.receiving) entry.gone = true;
      }
    },
    lookup(handle) {
      const entry = typeof handle === 'string' ? entries.get(handle) : undefined;
      if (!entry) throw fail('NotFoundError', `unknown midi handle '${String(handle ?? '')}'`);
      if (entry.gone && !entry.opened && !entry.receiving)
        throw fail('InvalidStateError', `${entry.handle} was unplugged`);
      return entry;
    },
  };
  return registry;
}

function shutError(entry) {
  if (entry.ended === 'seven')
    return fail('InvalidStateError', `${entry.handle} was closed in seven`);
  if (entry.ended === 'unplugged')
    return fail('InvalidStateError', `${entry.handle} was unplugged`);
  return fail('InvalidStateError', `${entry.handle} is not open (midi open ${entry.handle})`);
}

function clearOutput(port) {
  try {
    if (typeof port.clear === 'function') port.clear();
  } catch {}
}

async function releasePort(entry) {
  const { port } = entry;
  if (entry.type === 'output') clearOutput(port);
  try {
    if (port.connection === 'open' || entry.opened) await port.close();
  } catch {}
}

function trackHalt(entry, halt) {
  entry.haltReceive = halt;
  const forget = () => {
    if (entry.haltReceive === halt) entry.haltReceive = null;
  };
  void halt.finally(forget);
  setTimeout(forget, HALT_BUSY_MS);
  return halt;
}

function shut(registry, entry, why) {
  if (!entry.opened && !entry.opening && !entry.receiving && !entry.haltReceive)
    return entry.closing ?? Promise.resolve();
  const hadOpened = entry.opened;
  entry.closes += 1;
  entry.opened = false;
  entry.ended = why;
  try {
    entry.stopReceive?.(why);
  } catch {}
  const opening = entry.opening;
  entry.opening = null;
  entry.closing = (async () => {
    if (opening) {
      try {
        await opening;
      } catch {}
    }
    await Promise.race([
      Promise.allSettled([entry.receiveDone, entry.haltReceive].filter(Boolean)),
      new Promise((resolve) => setTimeout(resolve, HALT_BUSY_MS)),
    ]);
    await releasePort(entry);
    entry.opened = false;
    entry.receiving = false;
    entry.closing = null;
    noteClose(registry, entry, why);
  })();
  if (opening && !hadOpened) return Promise.resolve();
  return entry.closing;
}

async function open(registry, entry, stamp, enabled) {
  const closeSeen = entry.closes;
  const seen = registry.epoch;
  if (entry.closing && entry.closes === closeSeen) await entry.closing;
  if (off(enabled, registry, seen)) refuse();
  if (entry.closes !== closeSeen) throw shutError(entry);
  if (entry.opened) throw fail('InvalidStateError', `${entry.handle} is already open`);
  try {
    await entry.port.open();
  } catch (error) {
    if (entry.closes !== closeSeen) throw shutError(entry);
    if (off(enabled, registry, seen)) refuse();
    if (error?.name === 'InvalidStateError')
      throw fail('NoModificationAllowedError', `${entry.handle} is open in another tab or program`);
    throw error;
  }
  if (off(enabled, registry, seen)) {
    await releasePort(entry);
    refuse();
  }
  if (entry.closes !== closeSeen) {
    await releasePort(entry);
    throw shutError(entry);
  }
  if (entry.port.connection !== 'open') {
    await releasePort(entry);
    throw fail('InvalidStateError', `${entry.handle} was unplugged`);
  }
  entry.opened = true;
  entry.ended = null;
  entry.announced = true;
  registry.emit({
    type: 'open',
    handle: entry.handle,
    info: info(entry),
    stamp,
    since: Date.now(),
  });
}

function beginOpen(registry, entry, stamp, enabled) {
  if (entry.opening) return entry.opening;
  let settle;
  const flight = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  entry.opening = flight;
  open(registry, entry, stamp, enabled).then(
    (value) => {
      if (entry.opening === flight) entry.opening = null;
      settle.resolve(value);
    },
    (error) => {
      if (entry.opening === flight) entry.opening = null;
      settle.reject(error);
    }
  );
  return flight;
}

async function ensureOpen(registry, entry, stamp, enabled) {
  if (entry.opened) return;
  await beginOpen(registry, entry, stamp, enabled);
}

async function gather(reader, signal) {
  const chunks = [];
  let count = 0;
  for (;;) {
    const { value, done } = await race(reader.read(), signal);
    if (done) return { chunks, count };
    if (!value?.byteLength) continue;
    count += value.byteLength;
    if (count > LIMIT) throw fail('QuotaExceededError', 'a MIDI send is at most 64 KiB');
    chunks.push(value);
  }
}

function joined(chunks, count) {
  const out = new Uint8Array(count);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function timestampOf(options) {
  if (options.timestamp === undefined) return undefined;
  if (typeof options.timestamp !== 'number' || !Number.isFinite(options.timestamp))
    throw invalid('timestamp', options.timestamp);
  if (options.timestamp > performance.now() + SEND_AHEAD_MS)
    throw new TypeError(`timestamp is more than ${SEND_AHEAD_MS} ms ahead`);
  return options.timestamp;
}

async function refuseOutput(entry) {
  await releasePort(entry);
  entry.opened = false;
  refuse();
}

async function send(registry, entry, options, body, signal, enabled, stamp) {
  if (entry.type !== 'output')
    throw new TypeError(`${entry.handle} is an input (midi send needs an output)`);
  const stampTime = timestampOf(options);
  const seen = registry.epoch;
  await ensureOpen(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) await refuseOutput(entry);
  const reader = body.getReader();
  try {
    const { chunks, count } = await gather(reader, signal);
    if (off(enabled, registry, seen)) await refuseOutput(entry);
    if (!entry.opened) throw shutError(entry);
    const bytes = validateMessages(joined(chunks, count), { sysex: registry.sysex });
    if (stampTime === undefined) await race(entry.port.send(bytes), signal);
    else await race(entry.port.send(bytes, stampTime), signal);
    if (off(enabled, registry, seen)) await refuseOutput(entry);
    if (!entry.opened) throw shutError(entry);
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (off(enabled, registry, seen)) await refuseOutput(entry);
    if (!entry.opened) throw shutError(entry);
    if (error?.name === 'InvalidStateError' && /disconnect|closed/i.test(String(error.message)))
      throw fail('InvalidStateError', `${entry.handle} was unplugged`);
    throw error;
  }
}

function receiveBusy(entry) {
  if (entry.receiving || entry.haltReceive)
    throw fail('NoModificationAllowedError', `another receive is in progress on ${entry.handle}`);
}

function receive(registry, entry, signal, enabled, stamp, progress) {
  if (entry.type !== 'input')
    throw new TypeError(`${entry.handle} is an output (midi receive needs an input)`);
  receiveBusy(entry);
  const seen = registry.epoch;
  entry.receiving = true;
  let over = false;
  let controller;
  let stopReceive;
  let flight = null;
  let dropped = 0;
  let quiet = null;
  const queue = [];
  const announce = () => {
    if (!progress || quiet || !dropped) return;
    progress(`${entry.handle}: ${dropped} messages dropped (nobody read in time)`);
    dropped = 0;
    quiet = setTimeout(() => {
      quiet = null;
      announce();
    }, QUIET);
  };
  const flush = () => {
    while (queue.length && controller && (controller.desiredSize ?? 0) > 0)
      controller.enqueue(queue.shift());
  };
  const onMessage = (event) => {
    if (over || !controller) return;
    const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data ?? []);
    if (!data.byteLength || (isSysex(data) && !registry.sysex)) return;
    if (queue.length >= RECEIVE_BUFFER) {
      dropped += 1;
      announce();
      queue.shift();
    }
    queue.push(frameMessage(event.timeStamp ?? performance.now(), data));
    flush();
  };
  const freeSlot = () => {
    if (entry.receiveDone === flight) entry.receiveDone = null;
    if (entry.stopReceive === stopReceive) entry.stopReceive = null;
    entry.receiving = false;
    entry.opened = false;
    noteClose(registry, entry, entry.ended ?? 'closed');
  };
  const done = () => {
    if (flight !== null) return flight;
    over = true;
    clearTimeout(quiet);
    quiet = null;
    queue.length = 0;
    signal.removeEventListener('abort', onAbort);
    if (entry.opening && !entry.announced && entry.ended == null) entry.closes += 1;
    flight = (async () => {
      try {
        entry.port.onmidimessage = null;
      } catch {}
      if (entry.stopReceive === stopReceive) entry.stopReceive = null;
      const halt = releasePort(entry);
      trackHalt(entry, halt);
      const bounded = Promise.race([
        Promise.allSettled([halt]),
        new Promise((resolve) => setTimeout(resolve, HALT_BUSY_MS)),
      ]);
      await bounded;
      freeSlot();
    })();
    entry.receiveDone = flight;
    return flight;
  };
  const failReceive = (error) => {
    if (over) return;
    void done();
    try {
      controller?.error(error);
    } catch {}
  };
  stopReceive = (why) => {
    entry.ended = why ?? entry.ended;
    if (off(enabled, registry, seen)) return failReceive(fail('NotAllowedError', OFF));
    return failReceive(shutError(entry));
  };
  const onAbort = () => {
    void done().then(() => {
      try {
        controller?.close();
      } catch {}
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  entry.stopReceive = stopReceive;
  return new ReadableStream(
    {
      async start(ctrl) {
        controller = ctrl;
        try {
          await ensureOpen(registry, entry, stamp, enabled);
          if (over) {
            try {
              entry.port.onmidimessage = null;
            } catch {}
            await releasePort(entry);
            entry.opened = false;
            return;
          }
          if (off(enabled, registry, seen)) return failReceive(fail('NotAllowedError', OFF));
          if (!entry.opened) return failReceive(shutError(entry));
          entry.port.onmidimessage = onMessage;
        } catch (error) {
          if (over) {
            try {
              entry.port.onmidimessage = null;
            } catch {}
            await releasePort(entry);
            entry.opened = false;
            return;
          }
          return failReceive(error);
        }
      },
      pull() {
        if (over) return;
        if (off(enabled, registry, seen)) return failReceive(fail('NotAllowedError', OFF));
        if (!entry.opened && !entry.receiving) return failReceive(shutError(entry));
        flush();
      },
      cancel() {
        return done();
      },
    },
    { highWaterMark: 1 }
  );
}

function hearAccess(registry, access) {
  if (registry.unhear) {
    registry.unhear();
    registry.unhear = null;
  }
  const onChange = (event) => {
    const port = event.port ?? event.target;
    if (!port) return;
    const entry = registry.adopt(port);
    if (!entry) return;
    if (port.state === 'disconnected') {
      entry.gone = true;
      if (entry.opened || entry.receiving || entry.haltReceive) shut(registry, entry, 'unplugged');
    } else {
      entry.gone = false;
    }
  };
  access.onstatechange = onChange;
  if (typeof access.addEventListener === 'function')
    access.addEventListener('statechange', onChange);
  registry.unhear = () => {
    if (access.onstatechange === onChange) access.onstatechange = null;
    if (typeof access.removeEventListener === 'function')
      access.removeEventListener('statechange', onChange);
  };
}

async function requestAccess(registry, requestMIDIAccess, options, signal, enabled, progress) {
  const sysex = options.sysex === true;
  if (options.sysex !== undefined && typeof options.sysex !== 'boolean')
    throw invalid('sysex', options.sysex);
  const seen = registry.epoch;
  if (registry.access && (!sysex || registry.sysex)) {
    hearAccess(registry, registry.access);
    registry.syncAccess(registry.access);
    if (off(enabled, registry, seen)) refuse();
    return JSON.stringify(registry.listed().map(info));
  }
  progress?.(WAITING);
  let access;
  try {
    access = await race(requestMIDIAccess(sysex ? { sysex: true } : {}), signal);
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
      throw fail('NotAllowedError', REFUSED);
    throw error;
  }
  if (off(enabled, registry, seen)) refuse();
  hearAccess(registry, access);
  registry.syncAccess(access);
  return JSON.stringify(registry.listed().map(info));
}

function answer(registry, requestMIDIAccess, asked, enabled) {
  const { kind, options, body, stamp, signal, progress } = asked;
  if (kind === 'midi.list') {
    if (!registry.access) return '[]';
    registry.syncAccess(registry.access);
    return JSON.stringify(registry.listed().map(info));
  }
  if (kind === 'midi.request')
    return requestAccess(registry, requestMIDIAccess, options, signal, enabled, progress);
  const entry = registry.lookup(options.handle);
  if (kind === 'midi.close') return shut(registry, entry, 'closed');
  if (kind === 'midi.open') {
    if (entry.opened) throw fail('InvalidStateError', `${entry.handle} is already open`);
    return beginOpen(registry, entry, stamp, enabled);
  }
  if (kind === 'midi.receive') return receive(registry, entry, signal, enabled, stamp, progress);
  return send(registry, entry, options, body, signal, enabled, stamp);
}

export function create(overrides = {}) {
  const env = (name) => (Object.hasOwn(overrides, name) ? overrides[name] : globalThis[name]);
  const enabled = overrides.enabled ?? (() => true);
  const registry = makeRegistry();

  function api() {
    const requestMIDIAccess = env('navigator')?.requestMIDIAccess;
    if (typeof requestMIDIAccess !== 'function') throw fail('NotSupportedError', MISSING);
    return requestMIDIAccess.bind(env('navigator'));
  }

  async function handle({
    kind,
    options = {},
    body,
    stamp,
    signal = new AbortController().signal,
    progress,
  }) {
    if (!Object.hasOwn(kinds, kind))
      throw fail('NotSupportedError', `slicc-devices does not answer ${kind}`);
    if (!enabled()) refuse();
    const requestMIDIAccess = api();
    const seen = registry.epoch;
    if (registry.access) registry.syncAccess(registry.access);
    if (off(enabled, registry, seen)) refuse();
    return answer(
      registry,
      requestMIDIAccess,
      { kind, options, body, stamp, signal, progress },
      enabled
    );
  }

  const prompts = {
    'midi.request': () => null,
  };

  const midi = {
    list: () => registry.listed().map(info),
    close: async (handle) => {
      const entry = registry.entries.get(handle);
      if (entry && (entry.opened || entry.opening || entry.receiving || entry.haltReceive))
        await shut(registry, entry, 'seven');
    },
    closeAll: async () => {
      registry.epoch += 1;
      for (const entry of registry.entries.values()) await shut(registry, entry, 'seven');
      if (registry.unhear) {
        registry.unhear();
        registry.unhear = null;
      }
    },
    watch(listener) {
      registry.watchers.add(listener);
      return () => registry.watchers.delete(listener);
    },
    enabled,
  };

  return { kinds, prompts, midi, handle };
}
