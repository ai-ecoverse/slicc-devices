export const LIMIT = 64 * 1024;
export const WAITING = "waiting for a click in seven's tab: choose a HID device";
export const OFF = "HID devices are off in seven's settings";
export const MISSING = 'this browser has no WebHID (use Chrome, Edge or Opera on a desktop)';
export const CANCELLED = 'no HID device was chosen';
export const LATE = 'nobody clicked within 5 min';
export const UNCLICKED = "choosing a HID device needs a click in seven's tab";

const reading = Object.freeze({ group: 'plugdev', session: false });
const writing = Object.freeze({ session: false });

export const kinds = Object.freeze({
  'hid.list': reading,
  'hid.request': reading,
  'hid.open': reading,
  'hid.close': reading,
  'hid.watch': reading,
  'hid.send': writing,
  'hid.send-feature': writing,
  'hid.receive-feature': writing,
});

const FILTER_KEYS = ['vendorId', 'productId', 'usagePage', 'usage'];

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

function usageKey(device) {
  const first = device.collections?.[0];
  if (!first) return '';
  return `${first.usagePage ?? ''}:${first.usage ?? ''}`;
}

function collectionsOf(device) {
  return (device.collections ?? []).map((collection) => {
    const out = {};
    if (collection.usagePage !== undefined) out.usagePage = collection.usagePage;
    if (collection.usage !== undefined) out.usage = collection.usage;
    return out;
  });
}

function info(entry) {
  const { device, handle } = entry;
  return {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? '',
    opened: entry.opened,
    collections: collectionsOf(device),
    ...(device.collections?.[0]?.usagePage !== undefined
      ? { usagePage: device.collections[0].usagePage }
      : {}),
    ...(device.collections?.[0]?.usage !== undefined ? { usage: device.collections[0].usage } : {}),
  };
}

function blank(handle, device) {
  return {
    handle,
    device,
    vendorId: device.vendorId,
    productId: device.productId,
    usage: usageKey(device),
    productName: device.productName ?? '',
    gone: false,
    opened: false,
    ended: null,
    closing: null,
    watching: false,
    stopWatch: null,
    opening: null,
  };
}

function filtersOf(filters = []) {
  if (!Array.isArray(filters)) throw invalid('filters', filters);
  return filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw invalid('filters', filters);
    const out = {};
    for (const [key, value] of Object.entries(filter)) {
      if (!FILTER_KEYS.includes(key)) throw invalid('filters', filters);
      if (!whole(value, 0) || ((key === 'vendorId' || key === 'productId') && value > 0xffff))
        throw invalid(key, value);
      out[key] = value;
    }
    if (out.productId !== undefined && out.vendorId === undefined)
      throw invalid('filters', filters);
    return out;
  });
}

function reportIdOf(options) {
  if (!whole(options.reportId, 0) || options.reportId > 0xff)
    throw invalid('reportId', options.reportId);
  return options.reportId;
}

function makeRegistry() {
  const entries = new Map();
  const byDevice = new Map();
  const watchers = new Set();
  const heard = new WeakSet();
  let count = 0;
  const registry = {
    entries,
    watchers,
    epoch: 0,
    emit(event) {
      for (const watcher of watchers) {
        try {
          watcher(event);
        } catch {}
      }
    },
    listed: () => [...entries.values()].filter((entry) => !entry.gone),
    adopt(device, { reclaim = true } = {}) {
      let entry = byDevice.get(device);
      if (entry) {
        if (entry.gone) entry.gone = false;
        return entry;
      }
      const vendorId = device.vendorId;
      const productId = device.productId;
      const usage = usageKey(device);
      const productName = device.productName ?? '';
      const same = [...entries.values()].filter(
        (old) =>
          old.gone &&
          !old.opened &&
          old.vendorId === vendorId &&
          old.productId === productId &&
          old.usage === usage &&
          old.productName === productName
      );
      if (reclaim && vendorId !== undefined && productId !== undefined && same.length === 1)
        [entry] = same;
      if (entry) {
        byDevice.delete(entry.device);
        entry.device = device;
        entry.gone = false;
        entry.usage = usage;
        entry.productName = productName;
      } else {
        count += 1;
        entry = blank(`hid${count}`, device);
        entries.set(entry.handle, entry);
      }
      byDevice.set(device, entry);
      return entry;
    },
    unplug(device) {
      const entry = byDevice.get(device);
      if (!entry) return;
      entry.gone = true;
      if (entry.opened) shut(registry, entry, 'unplugged');
    },
    listen(hid) {
      if (heard.has(hid)) return;
      heard.add(hid);
      hid.addEventListener('connect', (event) => {
        registry.adopt(event.device ?? event.target);
      });
      hid.addEventListener('disconnect', (event) => registry.unplug(event.device ?? event.target));
    },
    async sync(hid) {
      registry.listen(hid);
      const devices = await hid.getDevices();
      for (const device of devices) registry.adopt(device);
      for (const entry of entries.values()) {
        if (!entry.gone && !entry.opened && !devices.includes(entry.device)) entry.gone = true;
      }
    },
    lookup(handle) {
      const entry = typeof handle === 'string' ? entries.get(handle) : undefined;
      if (!entry) throw fail('NotFoundError', `unknown hid handle '${String(handle ?? '')}'`);
      if (entry.gone && !entry.opened)
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
  return fail('InvalidStateError', `${entry.handle} is not open (hid open ${entry.handle})`);
}

async function releaseDevice(entry) {
  const { device } = entry;
  try {
    if (device.opened) await device.close();
  } catch {}
}

function shut(registry, entry, why) {
  if (!entry.opened && !entry.watching) return entry.closing ?? Promise.resolve();
  entry.opened = false;
  entry.ended = why;
  try {
    entry.stopWatch?.(why);
  } catch {}
  entry.closing = (async () => {
    await releaseDevice(entry);
    entry.closing = null;
    registry.emit({ type: 'close', handle: entry.handle, why });
  })();
  return entry.closing;
}

async function open(registry, entry, stamp, enabled) {
  const seen = registry.epoch;
  if (entry.closing) await entry.closing;
  if (off(enabled, registry, seen)) refuse();
  if (entry.opened) throw fail('InvalidStateError', `${entry.handle} is already open`);
  try {
    await entry.device.open();
  } catch (error) {
    if (error?.name === 'InvalidStateError' || error?.name === 'NetworkError')
      throw fail('NoModificationAllowedError', `${entry.handle} is open in another tab or program`);
    throw error;
  }
  if (off(enabled, registry, seen)) {
    await releaseDevice(entry);
    refuse();
  }
  entry.opened = true;
  entry.ended = null;
  registry.emit({
    type: 'open',
    handle: entry.handle,
    info: info(entry),
    stamp,
    since: Date.now(),
  });
}

async function ensureOpen(registry, entry, stamp, enabled) {
  if (entry.opened) return;
  if (!entry.opening) {
    entry.opening = open(registry, entry, stamp, enabled).finally(() => {
      entry.opening = null;
    });
  }
  try {
    await entry.opening;
  } catch (error) {
    if (entry.opened) return;
    throw error;
  }
}

async function gather(reader, signal) {
  const chunks = [];
  let count = 0;
  for (;;) {
    const { value, done } = await race(reader.read(), signal);
    if (done) return { chunks, count };
    if (!value?.byteLength) continue;
    count += value.byteLength;
    if (count > LIMIT) throw fail('QuotaExceededError', 'a HID report is at most 64 KiB');
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

function reportBytes(view) {
  if (!view) return new Uint8Array(0);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function frame(reportId, data) {
  const bytes = reportBytes(data);
  const out = new Uint8Array(1 + bytes.byteLength);
  out[0] = reportId & 0xff;
  out.set(bytes, 1);
  return out;
}

async function send(registry, entry, options, body, signal, enabled, stamp, feature) {
  const reportId = reportIdOf(options);
  const seen = registry.epoch;
  await ensureOpen(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) refuse();
  const reader = body.getReader();
  try {
    const { chunks, count } = await gather(reader, signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
    const bytes = joined(chunks, count);
    const op = feature ? entry.device.sendFeatureReport : entry.device.sendReport;
    await race(op.call(entry.device, reportId, bytes), signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
    if (error?.name === 'NetworkError')
      throw fail('InvalidStateError', `${entry.handle} was unplugged`);
    throw error;
  }
}

async function receiveFeature(registry, entry, options, signal, enabled, stamp) {
  const reportId = reportIdOf(options);
  const seen = registry.epoch;
  await ensureOpen(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) refuse();
  let view;
  try {
    view = await race(entry.device.receiveFeatureReport(reportId), signal);
  } catch (error) {
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
    if (error?.name === 'NetworkError')
      throw fail('InvalidStateError', `${entry.handle} was unplugged`);
    throw error;
  }
  if (off(enabled, registry, seen)) refuse();
  if (!entry.opened) throw shutError(entry);
  const bytes = reportBytes(view);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function watch(registry, entry, signal, enabled, stamp) {
  if (entry.watching)
    throw fail('InvalidStateError', `another watch is in progress on ${entry.handle}`);
  const seen = registry.epoch;
  entry.watching = true;
  let over = false;
  let controller;
  let stopWatch;
  const onReport = (event) => {
    if (over || !controller) return;
    try {
      controller.enqueue(frame(event.reportId, event.data));
    } catch {}
  };
  const done = () => {
    if (over) return;
    over = true;
    entry.watching = false;
    if (entry.stopWatch === stopWatch) entry.stopWatch = null;
    entry.device.removeEventListener('inputreport', onReport);
    signal.removeEventListener('abort', onAbort);
  };
  const failWatch = (error) => {
    if (over) return;
    done();
    try {
      controller?.error(error);
    } catch {}
  };
  stopWatch = (why) => {
    entry.ended = why ?? entry.ended;
    if (off(enabled, registry, seen)) return failWatch(fail('NotAllowedError', OFF));
    return failWatch(shutError(entry));
  };
  const onAbort = () => {
    done();
    try {
      controller?.close();
    } catch {}
  };
  signal.addEventListener('abort', onAbort, { once: true });
  entry.stopWatch = stopWatch;
  return new ReadableStream(
    {
      async start(ctrl) {
        controller = ctrl;
        try {
          await ensureOpen(registry, entry, stamp, enabled);
          if (over) return;
          if (off(enabled, registry, seen)) return failWatch(fail('NotAllowedError', OFF));
          if (!entry.opened) return failWatch(shutError(entry));
          entry.device.addEventListener('inputreport', onReport);
        } catch (error) {
          return failWatch(error);
        }
      },
      pull() {
        if (over) return;
        if (off(enabled, registry, seen)) return failWatch(fail('NotAllowedError', OFF));
        if (!entry.opened) return failWatch(shutError(entry));
      },
      cancel() {
        done();
      },
    },
    { highWaterMark: 0 }
  );
}

async function request(registry, hid, options, signal, enabled) {
  const filters = filtersOf(options.filters);
  const seen = registry.epoch;
  let devices;
  try {
    devices = await race(hid.requestDevice({ filters }), signal);
  } catch (error) {
    if (error?.name === 'NotFoundError') throw fail('NotAllowedError', CANCELLED);
    if (error?.name === 'SecurityError') throw fail('NotAllowedError', UNCLICKED);
    throw error;
  }
  if (!Array.isArray(devices)) devices = devices ? [devices] : [];
  if (devices.length === 0) throw fail('NotAllowedError', CANCELLED);
  if (off(enabled, registry, seen)) refuse();
  const listed = devices.map((device) => info(registry.adopt(device, { reclaim: false })));
  return JSON.stringify(listed);
}

function answer(registry, hid, asked, enabled) {
  const { kind, options, body, stamp, signal } = asked;
  if (kind === 'hid.list') return JSON.stringify(registry.listed().map(info));
  if (kind === 'hid.request') return request(registry, hid, options, signal, enabled);
  const entry = registry.lookup(options.handle);
  if (kind === 'hid.close') return shut(registry, entry, 'closed');
  if (kind === 'hid.open') return open(registry, entry, stamp, enabled);
  if (kind === 'hid.watch') return watch(registry, entry, signal, enabled, stamp);
  if (kind === 'hid.send')
    return send(registry, entry, options, body, signal, enabled, stamp, false);
  if (kind === 'hid.send-feature')
    return send(registry, entry, options, body, signal, enabled, stamp, true);
  return receiveFeature(registry, entry, options, signal, enabled, stamp);
}

function prompt(stamp) {
  return {
    title: 'Choose a HID device',
    body: `${asker(stamp)} wants to use a HID device. Click Choose, then pick it in the browser's list.`,
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
  const active = () => env('navigator')?.userActivation?.isActive === true;
  const registry = makeRegistry();

  function api() {
    const hid = env('navigator')?.hid;
    if (!hid) throw fail('NotSupportedError', MISSING);
    return hid;
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
    const hid = api();
    const seen = registry.epoch;
    await registry.sync(hid);
    if (off(enabled, registry, seen)) refuse();
    return answer(registry, hid, { kind, options, body, stamp, signal, progress }, enabled);
  }

  const prompts = {
    'hid.request': (asked) => {
      if (!enabled() || !env('navigator')?.hid) return null;
      if (typed(asked.stamp) && active()) return null;
      asked.progress?.(WAITING);
      return prompt(asked.stamp);
    },
  };

  const hid = {
    list: () => registry.listed().map(info),
    close: async (handle) => {
      const entry = registry.entries.get(handle);
      if (entry?.opened) await shut(registry, entry, 'seven');
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

  return { kinds, prompts, hid, handle };
}
