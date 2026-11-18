export const LIMIT = 4 * 1024 * 1024;
export const WAITING = "waiting for a click in seven's tab: choose a USB device";
export const OFF = "USB devices are off in seven's settings";
export const MISSING = 'this browser has no WebUSB (use Chrome, Edge or Opera on a desktop)';
export const CANCELLED = 'no USB device was chosen';
export const LATE = 'nobody clicked within 5 min';
export const UNCLICKED = "choosing a USB device needs a click in seven's tab";

const reading = Object.freeze({ group: 'plugdev', session: false });
const writing = Object.freeze({ session: false });

export const kinds = Object.freeze({
  'usb.list': reading,
  'usb.request': reading,
  'usb.open': reading,
  'usb.close': reading,
  'usb.claim': reading,
  'usb.release': reading,
  'usb.transfer.in': reading,
  'usb.select': writing,
  'usb.reset': writing,
  'usb.clear-halt': writing,
  'usb.transfer.out': writing,
  'usb.control': writing,
});

const REQUEST_TYPES = ['standard', 'class', 'vendor'];
const RECIPIENTS = ['device', 'interface', 'endpoint', 'other'];
const DIRECTIONS = ['in', 'out'];
const FILTER_KEYS = [
  'vendorId',
  'productId',
  'classCode',
  'subclassCode',
  'protocolCode',
  'serialNumber',
];

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

export function holder(stamp) {
  const tags = tagsOf(stamp);
  const agent = tags.find((tag) => tag?.kind === 'agent' && typeof tag.agentId === 'string');
  if (agent) return `agent:${agent.agentId}`;
  if (
    tags.some(
      (tag) =>
        tag?.kind === 'user' && typeof tag.where === 'string' && tag.where.startsWith('terminal:')
    )
  )
    return 'user';
  if (whole(stamp?.uid, 0)) return `uid:${stamp.uid}`;
  return 'usb';
}

function whoOf(stamp) {
  const id = holder(stamp);
  return { key: id, label: id };
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

function claimKey(handle, iface) {
  return `${handle}:${iface}`;
}

function blank(handle, device, vendorId, productId, serialNumber) {
  return {
    handle,
    device,
    vendorId,
    productId,
    serialNumber,
    gone: false,
    opened: false,
    ended: null,
    closing: null,
    transfers: 0,
  };
}

function alternate(alt) {
  return {
    alternateSetting: alt.alternateSetting,
    interfaceClass: alt.interfaceClass,
    interfaceSubclass: alt.interfaceSubclass,
    interfaceProtocol: alt.interfaceProtocol,
    endpoints: (alt.endpoints ?? []).map((ep) => ({
      endpointNumber: ep.endpointNumber,
      direction: ep.direction,
      type: ep.type,
      packetSize: ep.packetSize,
    })),
  };
}

function interfacesOf(device, claims) {
  const config = device.configuration;
  if (!config) return [];
  return (config.interfaces ?? []).map((iface) => {
    const number = iface.interfaceNumber;
    const claimed = claims.get(number);
    const alts = (iface.alternates ?? []).map(alternate);
    return {
      interfaceNumber: number,
      claimed: Boolean(iface.claimed || claimed),
      holder: claimed?.label ?? undefined,
      alternates: alts,
    };
  });
}

function info(entry, claims) {
  const { device, handle } = entry;
  const out = {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    deviceClass: device.deviceClass ?? 0,
    opened: entry.opened,
  };
  if (device.productName) out.productName = device.productName;
  if (device.manufacturerName) out.manufacturerName = device.manufacturerName;
  if (device.serialNumber) out.serialNumber = device.serialNumber;
  if (device.configuration) out.configuration = device.configuration.configurationValue;
  out.interfaces = interfacesOf(device, claims?.get(handle) ?? new Map());
  return out;
}

function filtersOf(filters = []) {
  if (!Array.isArray(filters)) throw invalid('filters', filters);
  return filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw invalid('filters', filters);
    const out = {};
    for (const [key, value] of Object.entries(filter)) {
      if (!FILTER_KEYS.includes(key)) throw invalid('filters', filters);
      if (key === 'serialNumber') {
        if (typeof value !== 'string') throw invalid(key, value);
      } else if (
        !whole(value, 0) ||
        ((key === 'vendorId' || key === 'productId') && value > 0xffff)
      )
        throw invalid(key, value);
      out[key] = value;
    }
    if (out.productId !== undefined && out.vendorId === undefined)
      throw invalid('filters', filters);
    return out;
  });
}

function setupOf(options) {
  const requestType = options.requestType ?? 'vendor';
  const recipient = options.recipient ?? 'device';
  if (!REQUEST_TYPES.includes(requestType)) throw invalid('requestType', requestType);
  if (!RECIPIENTS.includes(recipient)) throw invalid('recipient', recipient);
  const fields = ['request', 'value', 'index'];
  const out = { requestType, recipient };
  for (const key of fields) {
    const value = options[key] ?? 0;
    if (!whole(value, 0) || value > 0xffff) throw invalid(key, value);
    out[key] = value;
  }
  return out;
}

function ifaceOf(options) {
  if (!whole(options.interface, 0) && !whole(options.interfaceNumber, 0))
    throw invalid('interface', options.interface ?? options.interfaceNumber);
  return options.interface ?? options.interfaceNumber;
}

function endpointOf(options) {
  if (!whole(options.endpoint, 0) || options.endpoint > 0xff)
    throw invalid('endpoint', options.endpoint);
  return options.endpoint;
}

function lengthOf(options, field = 'length') {
  if (!whole(options[field], 1)) throw invalid(field, options[field]);
  if (options[field] > LIMIT) throw fail('QuotaExceededError', `a usb transfer is at most 4 MiB`);
  return options[field];
}

function makeClaims() {
  const claims = new Map();
  const waiters = new Map();
  const pending = new Map();
  const listeners = new Set();

  const whoAt = (handle, iface) => claims.get(handle)?.get(iface);
  const ownerOf = (handle, iface) => whoAt(handle, iface)?.label;
  const list = (handle) => {
    const byIface = claims.get(handle);
    if (!byIface) return [];
    return [...byIface].map(([interfaceNumber, who]) => ({
      handle,
      interfaceNumber,
      owner: who.label,
      key: who.key,
    }));
  };
  const set = (handle, iface, who) => {
    let byIface = claims.get(handle);
    if (!byIface) {
      byIface = new Map();
      claims.set(handle, byIface);
    }
    byIface.set(iface, who);
  };
  const drop = (handle, iface) => {
    const byIface = claims.get(handle);
    if (!byIface) return;
    byIface.delete(iface);
    if (byIface.size === 0) claims.delete(handle);
  };
  const emit = (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  };
  const wake = (handle, iface) => {
    const key = claimKey(handle, iface);
    const queue = waiters.get(key);
    const next = queue?.shift();
    if (!next) {
      waiters.delete(key);
      return;
    }
    if (queue.length === 0) waiters.delete(key);
    set(handle, iface, next.who);
    pending.set(key, next.who.key);
    next.resolve();
  };
  const refused = (handle, heldBy, op, iface) => {
    if (op === 'claim')
      return fail(
        'NoModificationAllowedError',
        `${handle} is claimed by ${heldBy} (usb claim --wait ...)`
      );
    const where = iface === undefined ? `'${handle}'` : `'${handle}' interface ${iface}`;
    return fail(
      'NoModificationAllowedError',
      `usb ${op} ${where} refused: held by ${heldBy} (pass --force to override)`
    );
  };

  return {
    claims,
    listeners,
    ownerOf,
    whoAt,
    list,
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async acquire(handle, iface, who, wait, signal) {
      if (signal?.aborted) throw aborted(signal);
      const current = whoAt(handle, iface);
      if (current?.key === who.key) return 'held';
      if (!current) {
        set(handle, iface, who);
        pending.set(claimKey(handle, iface), who.key);
        return 'acquired';
      }
      if (!wait) throw refused(handle, current.label, 'claim', iface);
      await new Promise((resolve, reject) => {
        const key = claimKey(handle, iface);
        const queue = waiters.get(key) ?? [];
        const onAbort = () => {
          const at = queue.findIndex((w) => w.who.key === who.key);
          if (at >= 0) {
            const [waiter] = queue.splice(at, 1);
            if (queue.length === 0) waiters.delete(key);
            waiter?.reject(aborted(signal));
          }
        };
        const waiter = {
          who,
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject: (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
          },
        };
        queue.push(waiter);
        waiters.set(key, queue);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return 'acquired';
    },
    clearPending(handle, iface, who) {
      const key = claimKey(handle, iface);
      if (pending.get(key) === who.key) pending.delete(key);
    },
    release(handle, iface, who) {
      const current = whoAt(handle, iface);
      if (!current) return;
      if (current.key !== who.key) throw refused(handle, current.label, 'release', iface);
      this.clearPending(handle, iface, who);
      drop(handle, iface);
      wake(handle, iface);
    },
    wake,
    assertExclusive(handle, who, force, op) {
      const held = list(handle);
      const others = held.filter((c) => c.key !== who.key);
      if (others.length > 0 && !force) {
        const summary = others.map((c) => c.owner).join(', ');
        throw refused(handle, summary, op, others[0]?.interfaceNumber);
      }
      return others;
    },
    displace(handle, { reason, displacedBy, displaced }) {
      const prefix = `${handle}:`;
      for (const [key, queue] of [...waiters]) {
        if (!key.startsWith(prefix)) continue;
        waiters.delete(key);
        for (const waiter of queue) {
          try {
            waiter.reject(refused(handle, displacedBy, reason));
          } catch {}
        }
      }
      for (const key of [...pending.keys()]) if (key.startsWith(prefix)) pending.delete(key);
      claims.delete(handle);
      const seen = new Set();
      for (const claim of displaced) {
        emit({
          type: 'claim-lost',
          handle,
          interfaceNumber: claim.interfaceNumber,
          holder: claim.owner,
          displacedBy,
          reason,
        });
        if (seen.has(claim.key)) continue;
        seen.add(claim.key);
        emit({
          type: 'disconnect',
          handle,
          holder: claim.owner,
          displacedBy,
          reason,
        });
      }
    },
    dropAll(handle) {
      this.displace(handle, { reason: 'close', displacedBy: 'seven', displaced: list(handle) });
    },
  };
}

function makeRegistry(broker) {
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
      const serialNumber = device.serialNumber ?? '';
      const same = [...entries.values()].filter(
        (old) =>
          old.gone &&
          !old.opened &&
          old.vendorId === vendorId &&
          old.productId === productId &&
          old.serialNumber === serialNumber
      );
      if (reclaim && vendorId !== undefined && productId !== undefined && same.length === 1)
        [entry] = same;
      if (entry) {
        byDevice.delete(entry.device);
        entry.device = device;
        entry.gone = false;
        entry.serialNumber = serialNumber;
      } else {
        count += 1;
        entry = blank(`usb${count}`, device, vendorId, productId, serialNumber);
        entries.set(entry.handle, entry);
      }
      byDevice.set(device, entry);
      return entry;
    },
    unplug(device) {
      const entry = byDevice.get(device);
      if (!entry) return;
      entry.gone = true;
      if (entry.opened) shut(registry, broker, entry, 'unplugged');
    },
    listen(usb) {
      if (heard.has(usb)) return;
      heard.add(usb);
      usb.addEventListener('connect', (event) => {
        registry.adopt(event.device ?? event.target);
      });
      usb.addEventListener('disconnect', (event) => registry.unplug(event.device ?? event.target));
    },
    async sync(usb) {
      registry.listen(usb);
      const devices = await usb.getDevices();
      for (const device of devices) registry.adopt(device);
      for (const entry of entries.values()) {
        if (!entry.gone && !entry.opened && !devices.includes(entry.device)) entry.gone = true;
      }
    },
    lookup(handle) {
      const entry = typeof handle === 'string' ? entries.get(handle) : undefined;
      if (!entry) throw fail('NotFoundError', `unknown usb handle '${String(handle ?? '')}'`);
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
  return fail('InvalidStateError', `${entry.handle} is not open (usb open ${entry.handle})`);
}

function notOpen(entry) {
  if (!entry.opened) throw shutError(entry);
}

async function releaseDevice(entry) {
  const { device } = entry;
  try {
    if (device.opened) await device.close();
  } catch {}
}

function shut(registry, broker, entry, why, displace) {
  if (!entry.opened) return entry.closing ?? Promise.resolve();
  entry.opened = false;
  entry.ended = why;
  if (displace) broker.displace(entry.handle, displace);
  else broker.dropAll(entry.handle);
  entry.closing = (async () => {
    await releaseDevice(entry);
    entry.closing = null;
    registry.emit({ type: 'close', handle: entry.handle, why });
  })();
  return entry.closing;
}

async function open(registry, broker, entry, stamp, enabled) {
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
    info: info(entry, broker.claims),
    stamp,
    since: Date.now(),
  });
}

async function exclusive(registry, broker, entry, who, force, op, enabled) {
  const seen = registry.epoch;
  notOpen(entry);
  const displaced = broker.assertExclusive(entry.handle, who, force, op);
  const displace = { reason: op, displacedBy: who.label, displaced };
  if (op === 'close') return shut(registry, broker, entry, 'closed', displace);
  await entry.device.reset();
  if (off(enabled, registry, seen)) refuse();
  broker.displace(entry.handle, displace);
}

async function claim(registry, broker, entry, options, stamp, signal, enabled) {
  const iface = ifaceOf(options);
  const wait = options.wait === true;
  if (options.wait !== undefined && typeof options.wait !== 'boolean')
    throw invalid('wait', options.wait);
  const who = whoOf(stamp);
  const seen = registry.epoch;
  notOpen(entry);
  const result = await broker.acquire(entry.handle, iface, who, wait, signal);
  if (result === 'held') return;
  try {
    if (off(enabled, registry, seen)) refuse();
    if (signal.aborted) throw aborted(signal);
    await entry.device.claimInterface(iface);
    if (off(enabled, registry, seen)) {
      try {
        await entry.device.releaseInterface(iface);
      } catch {}
      broker.release(entry.handle, iface, who);
      refuse();
    }
  } catch (error) {
    if (broker.whoAt(entry.handle, iface)?.key === who.key)
      broker.release(entry.handle, iface, who);
    else broker.wake(entry.handle, iface);
    throw error;
  } finally {
    broker.clearPending(entry.handle, iface, who);
  }
}

async function release(broker, entry, options, stamp) {
  const iface = ifaceOf(options);
  const who = whoOf(stamp);
  notOpen(entry);
  const current = broker.whoAt(entry.handle, iface);
  if (!current) {
    try {
      await entry.device.releaseInterface(iface);
    } catch {}
    return;
  }
  if (current.key !== who.key)
    throw fail('NoModificationAllowedError', `${entry.handle} is claimed by ${current.label}`);
  await entry.device.releaseInterface(iface);
  broker.release(entry.handle, iface, who);
}

async function select(entry, options, enabled, registry) {
  const seen = registry.epoch;
  notOpen(entry);
  const value = options.configuration ?? options.configurationValue;
  if (!whole(value, 1)) throw invalid('configuration', value);
  await entry.device.selectConfiguration(value);
  if (off(enabled, registry, seen)) refuse();
}

async function clearHalt(broker, entry, options, enabled, registry, stamp) {
  const seen = registry.epoch;
  notOpen(entry);
  const direction = options.direction;
  if (!DIRECTIONS.includes(direction)) throw invalid('direction', direction);
  const endpoint = endpointOf(options);
  requireEndpointClaim(broker, entry, endpoint, direction, stamp);
  await entry.device.clearHalt(direction, endpoint);
  if (off(enabled, registry, seen)) refuse();
  notOpen(entry);
  requireEndpointClaim(broker, entry, endpoint, direction, stamp, { lost: true });
}

async function gather(reader, signal) {
  const chunks = [];
  let count = 0;
  for (;;) {
    const { value, done } = await race(reader.read(), signal);
    if (done) return { chunks, count };
    if (!value?.byteLength) continue;
    count += value.byteLength;
    if (count > LIMIT) throw fail('QuotaExceededError', 'a usb transfer is at most 4 MiB');
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

function transferData(result) {
  if (!result?.data) return new Uint8Array(0);
  const { buffer, byteOffset, byteLength } = result.data;
  return new Uint8Array(buffer, byteOffset, byteLength);
}

function assertTransferOk(result) {
  const status = result?.status ?? 'ok';
  if (status === 'ok') return;
  if (status === 'stall') throw fail('NetworkError', 'The transfer stalled.');
  if (status === 'babble') throw fail('NetworkError', 'The transfer babble.');
  throw fail('NetworkError', `usb transfer status '${status}'`);
}

function activeAlternate(iface) {
  if (iface.alternate) return iface.alternate;
  const alternates = iface.alternates ?? [];
  const setting = iface.alternateSetting ?? 0;
  const matched = alternates.find((alt) => alt.alternateSetting === setting);
  if (matched) return matched;
  return alternates[0];
}

function interfaceForEndpoint(entry, endpoint, direction) {
  for (const iface of entry.device.configuration?.interfaces ?? []) {
    const alt = activeAlternate(iface);
    for (const ep of alt?.endpoints ?? []) {
      if (ep.endpointNumber === endpoint && ep.direction === direction)
        return iface.interfaceNumber;
    }
  }
  throw invalid('endpoint', endpoint);
}

function requireClaim(broker, entry, iface, stamp, { lost = false } = {}) {
  const who = whoOf(stamp);
  const current = broker.whoAt(entry.handle, iface);
  if (lost && (!current || current.key !== who.key))
    throw fail('NoModificationAllowedError', `${entry.handle} claim was lost`);
  if (!current)
    throw fail(
      'NoModificationAllowedError',
      `${entry.handle} interface ${iface} is not claimed (usb claim ${entry.handle} ${iface})`
    );
  if (current.key !== who.key)
    throw fail('NoModificationAllowedError', `${entry.handle} is claimed by ${current.label}`);
}

function requireEndpointClaim(broker, entry, endpoint, direction, stamp, opts) {
  requireClaim(broker, entry, interfaceForEndpoint(entry, endpoint, direction), stamp, opts);
}

function requireSetupClaim(broker, entry, setup, stamp, opts) {
  if (setup.recipient === 'interface') requireClaim(broker, entry, setup.index, stamp, opts);
  if (setup.recipient === 'endpoint') {
    const direction = setup.index & 0x80 ? 'in' : 'out';
    requireEndpointClaim(broker, entry, setup.index & 0x0f, direction, stamp, opts);
  }
}

async function transferOut(registry, broker, entry, options, body, signal, enabled, stamp) {
  const seen = registry.epoch;
  notOpen(entry);
  const endpoint = endpointOf(options);
  requireEndpointClaim(broker, entry, endpoint, 'out', stamp);
  const reader = body.getReader();
  try {
    const { chunks, count } = await gather(reader, signal);
    if (off(enabled, registry, seen)) refuse();
    notOpen(entry);
    requireEndpointClaim(broker, entry, endpoint, 'out', stamp, { lost: true });
    const bytes = joined(chunks, count);
    const result = await race(entry.device.transferOut(endpoint, bytes), signal);
    if (off(enabled, registry, seen)) refuse();
    notOpen(entry);
    requireEndpointClaim(broker, entry, endpoint, 'out', stamp, { lost: true });
    assertTransferOk(result);
    return String(result?.bytesWritten ?? count);
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
    if (error?.name === 'NetworkError' && !/stalled|babble|status/.test(error.message ?? ''))
      throw fail('InvalidStateError', `${entry.handle} was unplugged`);
    throw error;
  }
}

async function control(registry, broker, entry, options, body, signal, enabled, stamp) {
  const seen = registry.epoch;
  notOpen(entry);
  const setup = setupOf(options);
  requireSetupClaim(broker, entry, setup, stamp);
  if (options.length !== undefined) {
    const length = lengthOf(options);
    let result;
    try {
      result = await race(entry.device.controlTransferIn(setup, length), signal);
    } catch (error) {
      if (off(enabled, registry, seen)) refuse();
      if (!entry.opened) throw shutError(entry);
      throw error;
    }
    if (off(enabled, registry, seen)) refuse();
    notOpen(entry);
    requireSetupClaim(broker, entry, setup, stamp, { lost: true });
    assertTransferOk(result);
    const bytes = transferData(result);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  const reader = body.getReader();
  try {
    const { chunks, count } = await gather(reader, signal);
    if (off(enabled, registry, seen)) refuse();
    notOpen(entry);
    requireSetupClaim(broker, entry, setup, stamp, { lost: true });
    const bytes = joined(chunks, count);
    const result = await race(entry.device.controlTransferOut(setup, bytes), signal);
    if (off(enabled, registry, seen)) refuse();
    notOpen(entry);
    requireSetupClaim(broker, entry, setup, stamp, { lost: true });
    assertTransferOk(result);
    return String(result?.bytesWritten ?? count);
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.opened) throw shutError(entry);
    throw error;
  }
}

function endTransfer(controller, entry, enabled, registry, seen) {
  if (!entry.opened && entry.ended === 'unplugged') return controller.error(shutError(entry));
  if (off(enabled, registry, seen)) return controller.error(fail('NotAllowedError', OFF));
  return controller.close();
}

function failTransfer(controller, entry, error, enabled, registry, seen) {
  if (error?.name === 'AbortError') return controller.close();
  if (enabled && registry && off(enabled, registry, seen))
    return controller.error(fail('NotAllowedError', OFF));
  if (!entry.opened) return controller.error(shutError(entry));
  if (error?.name === 'NetworkError' && !/stalled|babble|status/.test(error.message ?? ''))
    return controller.error(fail('InvalidStateError', `${entry.handle} was unplugged`));
  return controller.error(error);
}

function transferIn(registry, broker, entry, options, signal, enabled, stamp) {
  const follow = options.follow === true;
  if (options.follow !== undefined && typeof options.follow !== 'boolean')
    throw invalid('follow', options.follow);
  const length = lengthOf(options);
  const endpoint = endpointOf(options);
  notOpen(entry);
  requireEndpointClaim(broker, entry, endpoint, 'in', stamp);
  entry.transfers += 1;
  const session = entry.transfers;
  const seen = registry.epoch;
  let over = false;
  const done = () => {
    if (over) return;
    over = true;
    if (entry.transfers === session) entry.transfers -= 1;
    signal.removeEventListener('abort', done);
  };
  signal.addEventListener('abort', done, { once: true });
  const idle = (controller) => {
    const unplugged = entry.ended === 'unplugged';
    done();
    return unplugged ? controller.error(shutError(entry)) : controller.close();
  };
  const step = async (controller) => {
    if (over) return controller.close();
    if (off(enabled, registry, seen) || !entry.opened) return idle(controller);
    try {
      requireEndpointClaim(broker, entry, endpoint, 'in', stamp, { lost: true });
      const result = await race(entry.device.transferIn(endpoint, length), signal);
      if (over) return;
      if (off(enabled, registry, seen) || !entry.opened) {
        done();
        return endTransfer(controller, entry, enabled, registry, seen);
      }
      requireEndpointClaim(broker, entry, endpoint, 'in', stamp, { lost: true });
      assertTransferOk(result);
      controller.enqueue(transferData(result));
      if (!follow) {
        done();
        return controller.close();
      }
    } catch (error) {
      done();
      return failTransfer(controller, entry, error, enabled, registry, seen);
    }
  };
  return new ReadableStream({ pull: step, cancel: done }, { highWaterMark: 0 });
}

async function request(registry, usb, options, signal, enabled) {
  const filters = filtersOf(options.filters);
  const seen = registry.epoch;
  let device;
  try {
    device = await race(usb.requestDevice({ filters }), signal);
  } catch (error) {
    if (error?.name === 'NotFoundError') throw fail('NotAllowedError', CANCELLED);
    if (error?.name === 'SecurityError') throw fail('NotAllowedError', UNCLICKED);
    throw error;
  }
  if (off(enabled, registry, seen)) refuse();
  const entry = registry.adopt(device, { reclaim: false });
  return JSON.stringify(info(entry, registry.broker.claims));
}

function answer(registry, broker, usb, asked, enabled) {
  const { kind, options, body, stamp, signal } = asked;
  if (kind === 'usb.list')
    return JSON.stringify(registry.listed().map((entry) => info(entry, broker.claims)));
  if (kind === 'usb.request') return request(registry, usb, options, signal, enabled);
  const entry = registry.lookup(options.handle);
  if (kind === 'usb.close')
    return exclusive(
      registry,
      broker,
      entry,
      whoOf(stamp),
      options.force === true,
      'close',
      enabled
    );
  if (kind === 'usb.reset')
    return exclusive(
      registry,
      broker,
      entry,
      whoOf(stamp),
      options.force === true,
      'reset',
      enabled
    );
  if (kind === 'usb.open') return open(registry, broker, entry, stamp, enabled);
  if (kind === 'usb.claim') return claim(registry, broker, entry, options, stamp, signal, enabled);
  if (kind === 'usb.release') return release(broker, entry, options, stamp);
  if (kind === 'usb.select') return select(entry, options, enabled, registry);
  if (kind === 'usb.clear-halt') return clearHalt(broker, entry, options, enabled, registry, stamp);
  if (kind === 'usb.transfer.in')
    return transferIn(registry, broker, entry, options, signal, enabled, stamp);
  if (kind === 'usb.transfer.out')
    return transferOut(registry, broker, entry, options, body, signal, enabled, stamp);
  return control(registry, broker, entry, options, body, signal, enabled, stamp);
}

function prompt(stamp) {
  return {
    title: 'Choose a USB device',
    body: `${asker(stamp)} wants to use a USB device. Click Choose, then pick it in the browser's list.`,
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
  const broker = makeClaims();
  const registry = makeRegistry(broker);
  registry.broker = broker;

  function api() {
    const usb = env('navigator')?.usb;
    if (!usb) throw fail('NotSupportedError', MISSING);
    return usb;
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
    const usb = api();
    const seen = registry.epoch;
    await registry.sync(usb);
    if (off(enabled, registry, seen)) refuse();
    return answer(registry, broker, usb, { kind, options, body, stamp, signal, progress }, enabled);
  }

  const prompts = {
    'usb.request': (asked) => {
      if (!enabled() || !env('navigator')?.usb) return null;
      if (typed(asked.stamp) && active()) return null;
      asked.progress?.(WAITING);
      return prompt(asked.stamp);
    },
  };

  const usb = {
    list: () => registry.listed().map((entry) => info(entry, broker.claims)),
    close: async (handle) => {
      const entry = registry.entries.get(handle);
      if (entry?.opened) await shut(registry, broker, entry, 'seven');
    },
    closeAll: async () => {
      registry.epoch += 1;
      for (const entry of registry.entries.values()) await shut(registry, broker, entry, 'seven');
    },
    watch(listener) {
      registry.watchers.add(listener);
      const stopClaims = broker.watch(listener);
      return () => {
        registry.watchers.delete(listener);
        stopClaims();
      };
    },
  };

  return { kinds, prompts, usb, handle };
}
