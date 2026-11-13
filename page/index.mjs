export const LIMIT = 4 * 1024 * 1024;
export const BUFFER = 1024 * 1024;
export const WAITING = "waiting for a click in seven's tab: choose a serial port";
export const OFF = "serial ports are off in seven's settings";
export const MISSING = 'this browser has no Web Serial (use Chrome, Edge or Opera on a desktop)';
export const CANCELLED = 'no serial port was chosen';
export const LATE = 'nobody clicked within 5 min';
export const UNCLICKED = "choosing a serial port needs a click in seven's tab";

const CHUNK = 65536;
const TIMEOUT = 1000;
const QUIET = 250;
const reading = Object.freeze({ group: 'dialout', session: false });
const writing = Object.freeze({ session: false });

export const kinds = Object.freeze({
  'serial.list': reading,
  'serial.request': reading,
  'serial.open': reading,
  'serial.read': reading,
  'serial.signals': reading,
  'serial.close': reading,
  'serial.write': writing,
  'serial.control': writing,
  'serial.esptool': writing,
});

const PARITIES = ['none', 'even', 'odd'];
const FLOWS = ['none', 'hardware'];
const IDS = ['usbVendorId', 'usbProductId', 'bluetoothServiceClassId'];
const SIGNALS = ['dataTerminalReady', 'requestToSend', 'break'];
const BRIDGES = [0x0403, 0x10c4, 0x1a86, 0x067b];
const TERMIOS = Object.freeze({
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
});
const SETTINGS = Object.keys(TERMIOS);

function fail(name, message) {
  return new DOMException(message, name);
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;

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

function hex(text) {
  if (typeof text !== 'string' || !/^([0-9a-f]{2})+$/i.test(text)) throw invalid('until', text);
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function find(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function joined(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function filtersOf(filters = []) {
  if (!Array.isArray(filters)) throw invalid('filters', filters);
  return filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw invalid('filters', filters);
    const out = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'bluetoothServiceClassId') {
        if (typeof value !== 'string' && !whole(value, 0)) throw invalid(key, value);
      } else if (key === 'usbVendorId' || key === 'usbProductId') {
        if (!whole(value, 0) || value > 0xffff) throw invalid(key, value);
      } else throw invalid('filters', filters);
      out[key] = value;
    }
    if (out.usbProductId !== undefined && out.usbVendorId === undefined)
      throw invalid('filters', filters);
    return out;
  });
}

function openOptions(options) {
  const { baudRate, dataBits, stopBits, parity, flowControl, bufferSize } = options;
  if (!whole(baudRate, 1)) throw invalid('baudRate', baudRate);
  const out = { baudRate };
  if (dataBits !== undefined) {
    if (dataBits !== 7 && dataBits !== 8) throw invalid('dataBits', dataBits);
    out.dataBits = dataBits;
  }
  if (stopBits !== undefined) {
    if (stopBits !== 1 && stopBits !== 2) throw invalid('stopBits', stopBits);
    out.stopBits = stopBits;
  }
  if (parity !== undefined) {
    if (!PARITIES.includes(parity)) throw invalid('parity', parity);
    out.parity = parity;
  }
  if (flowControl !== undefined) {
    if (!FLOWS.includes(flowControl)) throw invalid('flowControl', flowControl);
    out.flowControl = flowControl;
  }
  if (bufferSize !== undefined) {
    if (!whole(bufferSize, 1)) throw invalid('bufferSize', bufferSize);
    out.bufferSize = bufferSize;
  }
  return out;
}

function readOptions(options) {
  const { bytes, until, timeout, follow } = options;
  if (follow !== undefined && typeof follow !== 'boolean') throw invalid('follow', follow);
  if (follow && (bytes !== undefined || until !== undefined || timeout !== undefined))
    throw new TypeError('follow takes no bytes, until or timeout');
  if (bytes !== undefined && !whole(bytes, 1)) throw invalid('bytes', bytes);
  if (bytes > LIMIT)
    throw fail('QuotaExceededError', 'a serial read is at most 4 MiB without follow');
  if (timeout !== undefined && !whole(timeout, 0)) throw invalid('timeout', timeout);
  const mark = until === undefined ? null : hex(until);
  return {
    bytes: follow ? Infinity : (bytes ?? LIMIT),
    capped: !follow && bytes === undefined,
    until: mark,
    silence: follow || timeout === 0 ? Infinity : (timeout ?? TIMEOUT),
  };
}

function controlOptions(options) {
  const out = {};
  for (const key of SIGNALS) {
    if (options[key] === undefined) continue;
    if (typeof options[key] !== 'boolean') throw invalid(key, options[key]);
    out[key] = options[key];
  }
  if (!Object.keys(out).length)
    throw new TypeError('serial.control needs dataTerminalReady, requestToSend or break');
  return out;
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

const fatal = (error) => error?.name === 'NetworkError' || error?.name === 'NotFoundError';

function blank(handle, port, vid, pid, name, link) {
  return {
    handle,
    port,
    vid,
    pid,
    name,
    link,
    node: null,
    holder: null,
    gone: false,
    open: false,
    ended: null,
    session: 0,
    chunks: [],
    size: 0,
    dropped: 0,
    reading: false,
    report: null,
    quiet: null,
    wake: null,
    reader: null,
    writer: null,
    writes: Promise.resolve(),
    pump: Promise.resolve(),
    closing: null,
    esptool: null,
  };
}

function info(entry) {
  const given = entry.port.getInfo();
  const out = { handle: entry.handle };
  for (const key of IDS) if (given[key] !== undefined) out[key] = given[key];
  out.open = entry.open;
  if (entry.node) out.node = entry.node;
  return out;
}

const hex4 = (n) => n.toString(16).padStart(4, '0');

function named(registry, vid, pid) {
  const family = BRIDGES.includes(vid) ? 'ttyUSB' : 'ttyACM';
  const name = `${family}${registry.families[family]++}`;
  if (vid === undefined || pid === undefined) return { name, link: null };
  const id = `usb-${hex4(vid)}_${hex4(pid)}-if00`;
  const seen = registry.ids.get(id) ?? 0;
  registry.ids.set(id, seen + 1);
  return { name, link: seen ? `${id}-${seen}` : id };
}

function held(entry) {
  return fail('InvalidStateError', `${entry.handle} is open as ${entry.holder.node}`);
}

function taken(entry) {
  if (entry.esptool) return busy(entry);
  return fail(
    'NoModificationAllowedError',
    `${entry.handle} is open in serial (serial close ${entry.handle})`
  );
}

function hang(entry, why) {
  const lease = entry.holder;
  if (!lease) return;
  entry.holder = null;
  lease.why = why;
  lease.stop.abort();
}

function shutError(entry) {
  if (entry.ended === 'seven')
    return fail('InvalidStateError', `${entry.handle} was closed in seven`);
  if (entry.ended === 'unplugged')
    return fail('InvalidStateError', `${entry.handle} was unplugged`);
  return fail(
    'InvalidStateError',
    `${entry.handle} is not open (serial open ${entry.handle} --baud N)`
  );
}

function notOpen(entry) {
  if (!entry.open) throw shutError(entry);
}

function reset(entry) {
  entry.chunks = [];
  entry.size = 0;
  entry.dropped = 0;
  entry.report = null;
  clearTimeout(entry.quiet);
  entry.quiet = null;
}

function announce(entry) {
  if (!entry.report || entry.quiet || !entry.dropped) return;
  entry.report(`${entry.handle}: ${entry.dropped} bytes dropped (nobody read in time)`);
  entry.dropped = 0;
  entry.quiet = setTimeout(() => {
    entry.quiet = null;
    announce(entry);
  }, QUIET);
}

function keep(entry, bytes) {
  entry.chunks.push(bytes);
  entry.size += bytes.byteLength;
  while (entry.size > BUFFER) {
    const first = entry.chunks[0];
    const cut = Math.min(entry.size - BUFFER, first.byteLength);
    if (cut === first.byteLength) entry.chunks.shift();
    else entry.chunks[0] = first.subarray(cut);
    entry.size -= cut;
    entry.dropped += cut;
  }
  announce(entry);
  entry.wake?.();
}

function peek(entry, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of entry.chunks) {
    if (at === length) break;
    const piece = chunk.subarray(0, length - at);
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

function take(entry, length) {
  const out = peek(entry, length);
  let left = length;
  while (left > 0) {
    const first = entry.chunks[0];
    if (first.byteLength <= left) {
      entry.chunks.shift();
      left -= first.byteLength;
    } else {
      entry.chunks[0] = first.subarray(left);
      left = 0;
    }
  }
  entry.size -= length;
  return out;
}

async function drain(entry, session, reader) {
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return true;
      if (result.value?.byteLength && entry.session === session) keep(entry, result.value);
    }
  } catch (error) {
    return fatal(error);
  } finally {
    entry.reader = null;
    reader.releaseLock();
  }
}

async function pump(registry, entry, session) {
  const { port } = entry;
  while (entry.open && entry.session === session && port.readable) {
    const reader = port.readable.getReader();
    entry.reader = reader;
    if (await drain(entry, session, reader)) break;
  }
  if (entry.open && entry.session === session) shut(registry, entry, 'unplugged');
}

async function release(entry) {
  const { reader, writer, port } = entry;
  await Promise.allSettled([reader?.cancel()]);
  await entry.pump;
  if (writer) {
    await Promise.allSettled([writer.abort()]);
    writer.releaseLock();
    entry.writer = null;
  }
  await Promise.allSettled([port.close()]);
}

function shut(registry, entry, why) {
  if (!entry.open && entry.esptool) {
    entry.esptool.stop(why);
    return entry.esptool.done;
  }
  if (!entry.open) return entry.closing ?? Promise.resolve();
  entry.open = false;
  entry.ended = why;
  hang(entry, why);
  entry.wake?.();
  const tool = entry.esptool;
  entry.closing = (async () => {
    if (tool) {
      tool.stop(why);
      await tool.done;
    }
    if (!tool?.took) await release(entry);
    reset(entry);
    entry.closing = null;
    registry.emit({ type: 'close', handle: entry.handle, why });
  })();
  return entry.closing;
}

function off(enabled, registry, seen) {
  return !enabled() || registry.epoch !== seen;
}

function refuse() {
  throw fail('NotAllowedError', OFF);
}

async function begin(registry, entry, settings, seen, enabled) {
  try {
    await entry.port.open(settings);
  } catch (error) {
    if (error?.name === 'InvalidStateError' || error?.name === 'NetworkError')
      throw fail('InvalidStateError', `${entry.handle} is open in another tab or program`);
    throw error;
  }
  if (off(enabled, registry, seen)) {
    await Promise.allSettled([entry.port.close()]);
    refuse();
  }
  entry.open = true;
  entry.ended = null;
  entry.session += 1;
  reset(entry);
  entry.reading = false;
  entry.writes = Promise.resolve();
  entry.pump = pump(registry, entry, entry.session);
}

function opened(registry, entry, stamp, extra = {}) {
  registry.emit({
    type: 'open',
    handle: entry.handle,
    info: info(entry),
    stamp,
    since: Date.now(),
    ...extra,
  });
}

async function open(registry, entry, options, stamp, enabled) {
  const settings = openOptions(options);
  const seen = registry.epoch;
  if (entry.closing) await entry.closing;
  if (off(enabled, registry, seen)) refuse();
  if (entry.holder) throw held(entry);
  if (entry.open) throw fail('InvalidStateError', `${entry.handle} is already open`);
  await begin(registry, entry, settings, seen, enabled);
  opened(registry, entry, stamp);
}

function wait(entry, ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = (why) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      entry.wake = null;
      resolve(why);
    };
    const wake = () => finish('woke');
    const stop = () => finish('aborted');
    entry.wake = wake;
    if (Number.isFinite(ms)) timer = setTimeout(() => finish('silent'), ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

function slice(entry, plan, cursor) {
  let length = Math.min(entry.size, CHUNK, plan.bytes - cursor.sent);
  let found = false;
  if (plan.until) {
    const at = find(joined(cursor.seen, peek(entry, length)), plan.until);
    if (at >= 0) {
      length = at + plan.until.length - cursor.seen.length;
      found = true;
    }
  }
  const piece = take(entry, length);
  if (plan.until) {
    const all = joined(cursor.seen, piece);
    cursor.seen = all.subarray(Math.max(0, all.length - plan.until.length + 1));
  }
  cursor.sent += piece.byteLength;
  return { piece, found };
}

function read(entry, options, signal, progress) {
  const plan = readOptions(options);
  notOpen(entry);
  if (entry.reading)
    throw fail('InvalidStateError', `another read is in progress on ${entry.handle}`);
  entry.reading = true;
  const session = entry.session;
  const report = (line) => progress?.(line);
  entry.report = report;
  announce(entry);
  const cursor = { sent: 0, seen: new Uint8Array(0), over: false };
  const done = () => {
    if (cursor.over) return;
    cursor.over = true;
    if (entry.session === session) entry.reading = false;
    if (entry.report === report) entry.report = null;
    signal.removeEventListener('abort', done);
  };
  signal.addEventListener('abort', done, { once: true });
  const live = () => entry.open && entry.session === session;
  const step = async (controller) => {
    if (cursor.over) return controller.close();
    if (live() && entry.size > 0) {
      const { piece, found } = slice(entry, plan, cursor);
      controller.enqueue(piece);
      if (!found && cursor.sent < plan.bytes) return;
      done();
      if (found || !plan.capped) return controller.close();
      return controller.error(
        fail('QuotaExceededError', 'a serial read is at most 4 MiB without follow')
      );
    }
    if (!live()) {
      const unplugged = entry.session === session && entry.ended === 'unplugged';
      done();
      return unplugged ? controller.error(shutError(entry)) : controller.close();
    }
    const why = await wait(entry, plan.silence, signal);
    if (why !== 'woke') {
      done();
      return controller.close();
    }
    return step(controller);
  };
  return new ReadableStream({ pull: step, cancel: done }, { highWaterMark: 0 });
}

async function gather(reader, signal) {
  const chunks = [];
  let count = 0;
  for (;;) {
    const { value, done } = await race(reader.read(), signal);
    if (done) return { chunks, count };
    if (!value?.byteLength) continue;
    count += value.byteLength;
    if (count > LIMIT) throw fail('QuotaExceededError', 'a serial write is at most 4 MiB');
    chunks.push(value);
  }
}

async function pour(entry, reader, signal) {
  const { chunks, count } = await gather(reader, signal);
  if (!entry.open) throw shutError(entry);
  entry.writer ??= entry.port.writable.getWriter();
  const writer = entry.writer;
  let last = Promise.resolve();
  for (const chunk of chunks) {
    await race(writer.ready, signal);
    if (!entry.open) throw shutError(entry);
    last = writer.write(chunk);
    last.catch(() => {});
  }
  await race(last, signal);
  return String(count);
}

function write(entry, body, signal) {
  notOpen(entry);
  const session = entry.session;
  const run = async () => {
    const reader = body.getReader();
    try {
      if (!entry.open || entry.session !== session) throw shutError(entry);
      return await pour(entry, reader, signal);
    } catch (error) {
      await Promise.allSettled([reader.cancel()]);
      if (entry.session === session && !entry.open) throw shutError(entry);
      if (fatal(error)) throw fail('InvalidStateError', `${entry.handle} was unplugged`);
      throw error;
    }
  };
  const next = entry.writes.then(run);
  entry.writes = next.catch(() => {});
  return next;
}

async function signals(entry) {
  notOpen(entry);
  const given = await entry.port.getSignals();
  return JSON.stringify({
    clearToSend: Boolean(given.clearToSend),
    dataCarrierDetect: Boolean(given.dataCarrierDetect),
    dataSetReady: Boolean(given.dataSetReady),
    ringIndicator: Boolean(given.ringIndicator),
  });
}

async function control(entry, options) {
  const wanted = controlOptions(options);
  notOpen(entry);
  await entry.port.setSignals(wanted);
}

async function request(registry, serial, options, signal, enabled) {
  const filters = filtersOf(options.filters);
  const seen = registry.epoch;
  let port;
  try {
    port = await race(serial.requestPort({ filters }), signal);
  } catch (error) {
    if (error?.name === 'NotFoundError') throw fail('NotAllowedError', CANCELLED);
    if (error?.name === 'SecurityError') throw fail('NotAllowedError', UNCLICKED);
    throw error;
  }
  if (off(enabled, registry, seen)) refuse();
  const entry = registry.adopt(port, { reclaim: false });
  await registry.settle();
  return JSON.stringify(info(entry));
}

function makeRegistry() {
  const entries = new Map();
  const byPort = new Map();
  const watchers = new Set();
  const heard = new WeakSet();
  const changes = new Set();
  let count = 0;
  const registry = {
    entries,
    watchers,
    changes,
    families: { ttyUSB: 0, ttyACM: 0 },
    ids: new Map(),
    records: new Map(),
    epoch: 0,
    changed() {
      for (const change of changes) change();
    },
    settle: () => Promise.all([...changes].map((change) => change())),
    emit(event) {
      for (const watcher of watchers) {
        try {
          watcher(event);
        } catch {}
      }
    },
    listed: () => [...entries.values()].filter((entry) => !entry.gone || entry.open),
    adopt(port, { reclaim = true } = {}) {
      let entry = byPort.get(port);
      if (entry) {
        if (entry.gone) {
          entry.gone = false;
          registry.changed();
        }
        return entry;
      }
      const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
      const same = [...entries.values()].filter(
        (old) => old.gone && !old.open && old.vid === vid && old.pid === pid
      );
      if (reclaim && vid !== undefined && pid !== undefined && same.length === 1) [entry] = same;
      if (entry) {
        byPort.delete(entry.port);
        entry.port = port;
        entry.gone = false;
      } else {
        count += 1;
        const { name, link } = named(registry, vid, pid);
        entry = blank(`serial${count}`, port, vid, pid, name, link);
        entries.set(entry.handle, entry);
      }
      byPort.set(port, entry);
      registry.changed();
      return entry;
    },
    unplug(port) {
      const entry = byPort.get(port);
      if (!entry) return;
      entry.gone = true;
      if (entry.open) shut(registry, entry, 'unplugged');
      registry.changed();
    },
    listen(serial) {
      if (heard.has(serial)) return;
      heard.add(serial);
      serial.addEventListener('connect', (event) => {
        registry.adopt(event.target);
      });
      serial.addEventListener('disconnect', (event) => registry.unplug(event.target));
    },
    async sync(serial) {
      registry.listen(serial);
      const ports = await serial.getPorts();
      for (const port of ports) registry.adopt(port);
      for (const entry of entries.values()) {
        if (!entry.gone && !entry.open && !ports.includes(entry.port)) {
          entry.gone = true;
          registry.changed();
        }
      }
    },
    lookup(handle) {
      const entry = typeof handle === 'string' ? entries.get(handle) : undefined;
      if (!entry) throw fail('NotFoundError', `unknown serial handle '${String(handle ?? '')}'`);
      if (entry.gone && !entry.open)
        throw fail('InvalidStateError', `${entry.handle} was unplugged`);
      return entry;
    },
  };
  return registry;
}

async function takeOver(registry, entry, stamp) {
  entry.session += 1;
  entry.reading = false;
  entry.writes = Promise.resolve();
  entry.wake?.();
  if (entry.open) {
    await release(entry);
    reset(entry);
    return;
  }
  entry.open = true;
  entry.ended = null;
  reset(entry);
  registry.emit({
    type: 'open',
    handle: entry.handle,
    info: info(entry),
    stamp,
    since: Date.now(),
  });
}

function stopped(entry, why) {
  if (why === 'request') return fail('AbortError', 'the request was cancelled');
  if (why === 'unplugged') return fail('InvalidStateError', `${entry.handle} was unplugged`);
  if (why === 'seven') return fail('InvalidStateError', `${entry.handle} was closed in seven`);
  return fail('InvalidStateError', `${entry.handle} was closed`);
}

function claim(entry, signal) {
  if (entry.esptool) throw busy(entry);
  const stopper = new AbortController();
  let finish;
  const job = {
    took: false,
    signal: stopper.signal,
    stop: (why) => {
      if (!stopper.signal.aborted) stopper.abort(why);
    },
    done: new Promise((resolve) => {
      finish = resolve;
    }),
    quit: () => job.stop('request'),
    finish: () => {
      signal.removeEventListener('abort', job.quit);
      finish();
    },
  };
  entry.esptool = job;
  signal.addEventListener('abort', job.quit, { once: true });
  if (signal.aborted) job.quit();
  return job;
}

async function prepare(registry, entry, asked, enabled, load, job) {
  const { options, body, stamp } = asked;
  const seen = registry.epoch;
  const check = () => {
    if (off(enabled, registry, seen)) refuse();
    if (job.signal.aborted) throw stopped(entry, job.signal.reason);
  };
  try {
    const tool = await load();
    check();
    const plan = tool.plan(options);
    const data = await tool.firmware(plan, body, job.signal);
    if (entry.closing) await entry.closing;
    check();
    if (entry.gone && !entry.open) throw fail('InvalidStateError', `${entry.handle} was unplugged`);
    job.took = true;
    await takeOver(registry, entry, stamp);
    check();
    return { tool, plan, data };
  } catch (error) {
    entry.esptool = null;
    if (job.took && entry.open) await shut(registry, entry, 'closed');
    job.finish();
    if (off(enabled, registry, seen)) refuse();
    if (job.signal.aborted) throw stopped(entry, job.signal.reason);
    throw error;
  }
}

async function esptool(registry, entry, asked, enabled, load) {
  const job = claim(entry, asked.signal);
  const { tool, plan, data } = await prepare(registry, entry, asked, enabled, load, job);
  const session = entry.session;
  const { reply, done } = tool.run({
    port: entry.port,
    handle: entry.handle,
    plan,
    data,
    progress: asked.progress,
    signal: job.signal,
  });
  done
    .then(() => {
      entry.esptool = null;
      if (entry.open && entry.session === session) return shut(registry, entry, 'closed');
    })
    .then(job.finish);
  return reply;
}

function busy(entry) {
  return fail('InvalidStateError', `${entry.handle} is in use by esptool`);
}

function answer(registry, serial, asked, enabled, load) {
  const { kind, options, body, stamp, signal, progress } = asked;
  if (kind === 'serial.list') return JSON.stringify(registry.listed().map(info));
  if (kind === 'serial.request') return request(registry, serial, options, signal, enabled);
  const entry = registry.lookup(options.handle);
  if (entry.holder) throw held(entry);
  if (kind === 'serial.close') return shut(registry, entry, 'closed');
  if (kind === 'serial.esptool') return esptool(registry, entry, asked, enabled, load);
  if (entry.esptool) throw busy(entry);
  if (kind === 'serial.open') return open(registry, entry, options, stamp, enabled);
  if (kind === 'serial.read') return read(entry, options, signal, progress);
  if (kind === 'serial.write') return write(entry, body, signal);
  if (kind === 'serial.signals') return signals(entry);
  return control(entry, options);
}

function same(a, b) {
  return SETTINGS.every((key) => a[key] === b[key]);
}

function serialize(lease, task) {
  const next = lease.queue.then(task);
  lease.queue = next.catch(() => {});
  return next;
}

async function reconfigure(registry, entry, lease, args) {
  const settings = { ...TERMIOS, ...openOptions(args ?? {}) };
  if (entry.holder !== lease) throw stopped(entry, lease.why);
  if (same(lease.settings, settings)) return;
  entry.session += 1;
  await release(entry);
  if (entry.holder !== lease) throw stopped(entry, lease.why);
  try {
    await entry.port.open(settings);
  } catch (error) {
    await shut(registry, entry, 'closed');
    throw error;
  }
  if (entry.holder !== lease) {
    await Promise.allSettled([entry.port.close()]);
    throw stopped(entry, lease.why);
  }
  lease.record.settings = settings;
  lease.settings = settings;
  entry.pump = pump(registry, entry, entry.session);
}

function nodeReadable(entry, lease) {
  return new ReadableStream(
    {
      pull: async (controller) => {
        for (;;) {
          if (entry.holder !== lease) {
            if (lease.why === 'unplugged') return controller.error(stopped(entry, lease.why));
            return controller.close();
          }
          if (lease.stop.signal.aborted) return;
          if (entry.size > 0) return controller.enqueue(take(entry, Math.min(entry.size, CHUNK)));
          await wait(entry, Infinity, lease.stop.signal);
        }
      },
      cancel: () => lease.stop.abort(),
    },
    { highWaterMark: 0 }
  );
}

function nodeWritable(entry, lease) {
  return new WritableStream({
    write: (chunk) =>
      serialize(lease, async () => {
        if (entry.holder !== lease) throw stopped(entry, lease.why);
        entry.writer ??= entry.port.writable.getWriter();
        const writer = entry.writer;
        await writer.ready;
        await writer.write(chunk);
      }),
  });
}

async function nodeControl(registry, entry, lease, op, args) {
  if (op === 'close') {
    lease.stop.abort();
    if (entry.holder === lease) await shut(registry, entry, 'closed');
    return;
  }
  if (entry.holder !== lease) throw stopped(entry, lease.why);
  if (op === 'configure') return serialize(lease, () => reconfigure(registry, entry, lease, args));
  if (op === 'signals') {
    const given = await entry.port.getSignals();
    return {
      clearToSend: Boolean(given.clearToSend),
      dataCarrierDetect: Boolean(given.dataCarrierDetect),
      dataSetReady: Boolean(given.dataSetReady),
      ringIndicator: Boolean(given.ringIndicator),
    };
  }
  if (op === 'setSignals') {
    const wanted = controlOptions(args ?? {});
    if (!lease.writes)
      throw fail(
        'NotAllowedError',
        `${lease.node} is open for reading only: DTR, RTS and break need it open for writing (sudo)`
      );
    return entry.port.setSignals(wanted);
  }
  if (op === 'flush') {
    if (args?.input) {
      entry.chunks = [];
      entry.size = 0;
    }
    return;
  }
  throw new TypeError(`unknown control op: ${String(op)}`);
}

async function attach(registry, entry, record, asked, enabled) {
  const seen = registry.epoch;
  if (entry.closing) await entry.closing;
  if (off(enabled, registry, seen)) refuse();
  if (entry.gone) throw fail('InvalidStateError', `${entry.handle} was unplugged`);
  if (entry.open || entry.holder || entry.esptool) throw taken(entry);
  const lease = {
    node: `/dev/${entry.name}`,
    writes: asked.flags !== 0,
    record,
    settings: record.settings,
    stop: new AbortController(),
    queue: Promise.resolve(),
    why: null,
  };
  entry.holder = lease;
  try {
    await begin(registry, entry, lease.settings, seen, enabled);
  } catch (error) {
    if (entry.holder === lease) entry.holder = null;
    throw error;
  }
  opened(registry, entry, asked.stamp, { node: lease.node });
  return {
    readable: nodeReadable(entry, lease),
    writable: nodeWritable(entry, lease),
    control: (op, args) => nodeControl(registry, entry, lease, op, args),
  };
}

function follow(registry, kernel, serial) {
  const added = new Map();
  const refused = new WeakSet();
  let queue = Promise.resolve();
  let halted = false;
  const step = async () => {
    for (const entry of registry.entries.values()) {
      const want = !halted && !entry.gone;
      const have = added.get(entry);
      if (want && !have) {
        try {
          const node = await kernel.devices.add({
            path: entry.name,
            owner: 0,
            group: 'dialout',
            mode: 0o640,
            links: entry.link ? [entry.link] : [],
          });
          added.set(entry, node);
          refused.delete(entry);
          entry.node = `/dev/${entry.name}`;
          registry.records.set(entry.node, { entry, settings: TERMIOS });
        } catch (error) {
          if (refused.has(entry)) continue;
          refused.add(entry);
          console.warn(
            `slicc-devices: /dev/${entry.name} was not added (${String(error?.message ?? error)}); it is tried again on the next change of ports`
          );
        }
      } else if (!want && have) {
        added.delete(entry);
        registry.records.delete(entry.node);
        entry.node = null;
        await Promise.allSettled([have.remove()]);
      }
    }
  };
  const change = () => {
    queue = queue.then(step);
    return queue;
  };
  registry.changes.add(change);
  if (serial) registry.sync(serial).then(change, change);
  return {
    stop() {
      halted = true;
      registry.changes.delete(change);
      change();
      return queue;
    },
  };
}

function prompt(stamp) {
  return {
    title: 'Choose a serial port',
    body: `${asker(stamp)} wants to use a serial port. Click Choose, then pick it in the browser's list.`,
    action: 'Choose…',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: CANCELLED,
    late: LATE,
  };
}

export function create(overrides = {}) {
  const env = (name) => (Object.hasOwn(overrides, name) ? overrides[name] : globalThis[name]);
  const enabled = overrides.enabled ?? (() => true);
  const load = overrides.esptool ?? (() => import('./esptool.mjs'));
  const active = () => env('navigator')?.userActivation?.isActive === true;
  const registry = makeRegistry();

  function api() {
    const serial = env('navigator')?.serial;
    if (!serial) throw fail('NotSupportedError', MISSING);
    return serial;
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
    const serial = api();
    const seen = registry.epoch;
    await registry.sync(serial);
    await registry.settle();
    if (off(enabled, registry, seen)) refuse();
    return answer(
      registry,
      serial,
      { kind, options, body, stamp, signal, progress },
      enabled,
      load
    );
  }

  const prompts = {
    'serial.request': (asked) => {
      if (!enabled() || !env('navigator')?.serial) return null;
      if (typed(asked.stamp) && active()) return null;
      asked.progress?.(WAITING);
      return prompt(asked.stamp);
    },
  };

  const devices = {
    async open({ path, flags = 0, stamp, signal = new AbortController().signal }) {
      if (!enabled()) refuse();
      const serial = api();
      const seen = registry.epoch;
      await registry.sync(serial);
      if (off(enabled, registry, seen)) refuse();
      if (signal.aborted) throw aborted(signal);
      const record = registry.records.get(path);
      if (!record) throw fail('NotFoundError', `no serial port is ${String(path)}`);
      return attach(registry, record.entry, record, { flags, stamp }, enabled);
    },
    nodes(kernel) {
      if (typeof kernel?.devices?.add !== 'function')
        throw new TypeError('this kernel has no devices (slicc-kernel 1.183.0 or later)');
      return follow(registry, kernel, env('navigator')?.serial);
    },
  };

  const ports = {
    list: () => registry.listed().map(info),
    open: () => [...registry.entries.values()].filter((entry) => entry.open).map(info),
    close: async (handle) => {
      const entry = registry.entries.get(handle);
      if (entry?.open || entry?.esptool) await shut(registry, entry, 'seven');
    },
    closeAll: async () => {
      registry.epoch += 1;
      for (const entry of registry.entries.values()) await shut(registry, entry, 'seven');
    },
    watch(listener) {
      registry.watchers.add(listener);
      return () => registry.watchers.delete(listener);
    },
  };

  return { kinds, prompts, ports, handle, devices };
}

const page = create();

export const handle = page.handle;
export const prompts = page.prompts;
export const ports = page.ports;
export const devices = page.devices;

export default page;
