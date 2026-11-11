import { ESPLoader, Transport } from 'esptool-js/bundle.js';

export const FLASH_LIMIT = 16 * 1024 * 1024;
export const SECTOR = 4096;
export const BAUD = 115200;
export const OPS = [
  'chip_id',
  'read_mac',
  'flash_id',
  'read_reg',
  'read_flash',
  'erase_flash',
  'erase_region',
  'write_flash',
  'run',
];

const GAP = 250;
const TOP = 2 ** 32;
const PASSING = /\(\d+%\)$/;

function fail(name, message) {
  return new DOMException(message, name);
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;

function address(value, field = 'address') {
  if (!whole(value, 0) || value >= TOP) throw invalid(field, value);
  return value;
}

function size(value, at, field = 'size') {
  if (!whole(value, 1) || at + value > TOP) throw invalid(field, value);
  return value;
}

export const hex = (n) => `0x${n.toString(16)}`;

export function segmentsOf(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw invalid('segments', segments);
  let end = 0;
  let total = 0;
  return segments.map((segment, i) => {
    if (!segment || typeof segment !== 'object') throw invalid('segments', segments);
    const at = address(segment.address);
    const length = size(segment.size, at);
    if (i > 0 && at < end)
      throw new TypeError(
        `write_flash segments overlap or are out of order: ${hex(at)} starts before ${hex(end)}`
      );
    end = at + length;
    total += length;
    if (total > FLASH_LIMIT) throw new TypeError('write_flash takes at most 16 MiB');
    return { address: at, size: length };
  });
}

export function plan(options = {}) {
  const { op, baud = BAUD, chip, erase } = options;
  if (!OPS.includes(op)) throw invalid('op', op);
  if (!whole(baud, 1)) throw invalid('baud', baud);
  if (chip !== undefined && (typeof chip !== 'string' || !/^esp[0-9a-z]+$/.test(chip)))
    throw invalid('chip', chip);
  const out = { op, baud, chip };
  if (op === 'read_reg') out.address = address(options.address);
  if (op === 'read_flash' || op === 'erase_region') {
    out.address = address(options.address);
    out.size = size(options.size, out.address);
  }
  if (op === 'erase_region' && (out.address % SECTOR || out.size % SECTOR))
    throw new TypeError('erase_region needs a 4 KiB aligned address and size');
  if (op === 'write_flash') {
    if (erase !== undefined && typeof erase !== 'boolean') throw invalid('erase', erase);
    out.segments = segmentsOf(options.segments);
    out.erase = erase === true;
  }
  return out;
}

function aborted(signal) {
  return new Promise((_, reject) => {
    const stop = () => reject(fail('AbortError', 'the request was cancelled'));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
  });
}

export async function firmware(planned, body, signal) {
  if (planned.op !== 'write_flash') return null;
  const total = planned.segments.reduce((sum, segment) => sum + segment.size, 0);
  const out = new Uint8Array(total);
  let at = 0;
  const reader = body.getReader();
  const stop = aborted(signal);
  stop.catch(() => {});
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), stop]);
      if (done) break;
      if (!value?.byteLength) continue;
      if (at + value.byteLength > total)
        throw new TypeError(`the body is longer than the segments' ${total} bytes`);
      out.set(value, at);
      at += value.byteLength;
    }
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    throw error;
  }
  if (at !== total) throw new TypeError(`the body has ${at} bytes; the segments need ${total}`);
  return out;
}

export function pace(progress, now = () => Date.now()) {
  let queue = [];
  let last = -Infinity;
  let timer = null;
  let idle = [];
  const settle = () => {
    for (const resolve of idle) resolve();
    idle = [];
  };
  const send = () => {
    timer = null;
    const wait = last + GAP - now();
    if (wait > 0) {
      timer = setTimeout(send, wait);
      return;
    }
    const next = queue.shift();
    last = now();
    try {
      progress(next.line);
    } catch {}
    if (queue.length) timer = setTimeout(send, GAP);
    else settle();
  };
  return {
    say(line, passing = PASSING.test(line)) {
      if (!progress) return;
      const latest = { line, passing };
      const percent = passing ? null : queue.findLast((entry) => entry.passing);
      queue = percent ? [percent, latest] : [latest];
      if (!timer) send();
    },
    flush() {
      queue = queue.slice(-1);
      if (!queue.length) return Promise.resolve();
      return new Promise((resolve) => idle.push(resolve));
    },
  };
}

export function terminal(say) {
  let pending = '';
  const emit = (text) => {
    for (const line of text.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== 'esptool.js') say(trimmed);
    }
  };
  return {
    clean() {
      pending = '';
    },
    write(data) {
      pending += data;
    },
    writeLine(data) {
      emit(pending + data);
      pending = '';
    },
    flush() {
      if (pending) emit(pending);
      pending = '';
    },
  };
}

export const squash = (name) => name.toLowerCase().replace(/[^0-9a-z]/g, '');

class Mismatch extends Error {}

class Line extends Transport {
  trace() {}

  stop() {
    this.stopped = true;
    this.buffer = Uint8Array.of(0xdb, 0x00);
  }

  async read(timeout) {
    if (this.stopped) throw fail('AbortError', 'stopped');
    return super.read(timeout);
  }

  async write(data) {
    if (this.stopped) throw fail('AbortError', 'stopped');
    return super.write(data);
  }
}

class Loader extends ESPLoader {
  constructor(options, wanted) {
    super(options);
    this.wanted = wanted;
    this.synced = false;
  }

  async _connectAttempt(mode, strategy) {
    if (this.transport.stopped) throw fail('AbortError', 'stopped');
    return super._connectAttempt(mode, strategy);
  }

  async openAndSync(mode, attempts) {
    await super.openAndSync(mode, attempts);
    this.synced = true;
  }

  async detectChip(mode, attempts) {
    await super.detectChip(mode, attempts);
    const found = this.chip.CHIP_NAME;
    if (this.wanted && squash(found) !== this.wanted)
      throw new Mismatch(`this chip is ${found}, not ${this.wanted} (wrong --chip?)`);
  }
}

const lines = (list) => `${list.join('\n')}\n`;
const hex8 = (n) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
const word = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]);

const ACTIONS = {
  async chipId(loader) {
    const { chip } = loader;
    const features = await chip.getChipFeatures(loader);
    return lines([
      `Chip type: ${chip.CHIP_NAME}`,
      `Chip description: ${await chip.getChipDescription(loader)}`,
      `Features: ${features.map((feature) => feature.trim()).join(', ')}`,
      `Crystal: ${await chip.getCrystalFreq(loader)}MHz`,
      `MAC: ${await chip.readMac(loader)}`,
    ]);
  },
  async readMac(loader) {
    return lines([`MAC: ${await loader.chip.readMac(loader)}`]);
  },
  async flashId(loader) {
    const id = (await loader.readFlashId()) >>> 0;
    const device = (((id >>> 8) & 0xff) << 8) | ((id >>> 16) & 0xff);
    return lines([
      `Manufacturer: 0x${(id & 0xff).toString(16).padStart(2, '0')}`,
      `Device: 0x${device.toString(16).padStart(4, '0')}`,
      `Detected flash size: ${loader.DETECTED_FLASH_SIZES[(id >>> 16) & 0xff] ?? 'unknown'}`,
    ]);
  },
  async readReg(loader, planned) {
    const value = await loader.readReg(planned.address);
    return lines([`${hex(planned.address)} = ${hex8(value)}`]);
  },
  async readFlash(loader, planned, job) {
    let shown = -1;
    await loader.readFlash(planned.address, planned.size, (packet, got, total) => {
      job.feed(packet);
      const pct = Math.floor((got / total) * 100);
      if (pct !== shown) {
        shown = pct;
        job.say(`Reading flash at ${hex(planned.address)}... (${pct}%)`);
      }
    });
    return null;
  },
  async eraseFlash(loader) {
    await loader.eraseFlash();
    return 'flash erased\n';
  },
  async eraseRegion(loader, planned, job) {
    job.say(`Erasing region ${hex(planned.address)} (${planned.size} bytes)...`);
    const packet = new Uint8Array(8);
    packet.set(word(planned.address), 0);
    packet.set(word(planned.size), 4);
    const timeout = loader.timeoutPerMb(loader.ERASE_REGION_TIMEOUT_PER_MB, planned.size);
    await loader.checkCommand(
      'erase region',
      loader.ESP_ERASE_REGION,
      packet,
      undefined,
      undefined,
      timeout
    );
    return 'region erased\n';
  },
  async writeFlash(loader, planned, job) {
    let at = 0;
    const fileArray = planned.segments.map((segment) => {
      const data = job.data.subarray(at, at + segment.size);
      at += segment.size;
      return { data, address: segment.address };
    });
    await loader.writeFlash({
      fileArray,
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: planned.erase,
      compress: true,
    });
    return 'flash written\n';
  },
  async run(_loader, _planned, job) {
    job.say('Leaving bootloader; running app...');
    return 'running app\n';
  },
};

export function cleaned(message) {
  const first = String(message ?? '').split('\n')[0];
  return first
    .replace(/Invalid head of packet \(0x[0-9a-f]+\)/i, 'Invalid head of packet')
    .replace(/Invalid SLIP escape \(.*?\)/i, 'Invalid SLIP escape')
    .replace(/Unexpected response .*$/i, 'Unexpected response')
    .replace(/Guru Meditation Error detected.*$/i, 'Guru Meditation Error detected');
}

export function halted(handle, why, synced) {
  if (why === 'request') return fail('AbortError', 'the request was cancelled');
  if (why === 'unplugged') return fail('InvalidStateError', `${handle} was unplugged`);
  const where = why === 'seven' ? `${handle} was closed in seven` : `${handle} was closed`;
  if (!synced) return fail('InvalidStateError', where);
  return fail(
    'InvalidStateError',
    `${where}; the chip stays in its bootloader (press RESET, or esptool --port ${handle} run)`
  );
}

export function failure(error, handle, synced) {
  if (error instanceof Mismatch) return fail('OperationError', error.message);
  if (!synced && (error?.name === 'InvalidStateError' || error?.name === 'NetworkError'))
    return fail('InvalidStateError', `${handle} is open in another tab or program`);
  if (!synced)
    return fail(
      'OperationError',
      `no ESP chip answered on ${handle} (hold BOOT and press RESET, then try again)`
    );
  return fail('OperationError', cleaned(error?.message ?? error));
}

export function run({ port, handle, plan: planned, data, progress, signal }) {
  const pacer = pace(progress);
  const term = terminal((line) => pacer.say(line));
  const transport = new Line(port, false);
  const loader = new Loader(
    { transport, baudrate: planned.baud, terminal: term, debugLogging: false },
    planned.chip
  );
  let controller = null;
  const stream =
    planned.op === 'read_flash'
      ? new ReadableStream({
          start(c) {
            controller = c;
          },
        })
      : null;
  let connected;
  const ready = new Promise((resolve) => {
    connected = resolve;
  });
  const job = {
    data,
    say: (line) => pacer.say(line),
    feed: (packet) => controller.enqueue(Uint8Array.from(packet)),
  };
  const work = (async () => {
    await loader.main();
    connected();
    return ACTIONS[planned.op.replace(/_(.)/g, (_, c) => c.toUpperCase())](loader, planned, job);
  })();
  const stopped = aborted(signal);
  stopped.catch(() => {});
  const halt = () => transport.stop();
  signal.addEventListener('abort', halt, { once: true });
  if (signal.aborted) halt();
  const outcome = Promise.race([work, stopped]).then(
    (text) => ({ text }),
    (error) => ({
      error: signal.aborted
        ? halted(handle, signal.reason, loader.synced)
        : failure(error, handle, loader.synced),
    })
  );
  const done = outcome.then(async (result) => {
    await Promise.allSettled([work]);
    if (!signal.aborted && loader.synced) await Promise.allSettled([loader.after('hard_reset')]);
    signal.removeEventListener('abort', halt);
    term.flush();
    await Promise.allSettled([transport.disconnect()]);
    await pacer.flush();
    if (controller) {
      if (result.error) controller.error(result.error);
      else controller.close();
    }
  });
  const finished = done.then(() => outcome);
  const settled = stream
    ? Promise.race([ready.then(() => ({ text: stream })), finished])
    : finished;
  const reply = settled.then((result) => {
    if (result.error) throw result.error;
    return result.text;
  });
  return { reply, done };
}
