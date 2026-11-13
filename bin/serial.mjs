export const LIMIT = 4 * 1024 * 1024;

export const HELP = `serial - access serial ports via Web Serial

Usage: serial <subcommand> [options]

Subcommands:
  list                              List currently-granted ports
  request [--vid 0x.. --pid 0x..]   Open the port picker; prints a handle
  open <handle> [open flags]        Open a port
  close <handle>                    Close a port
  read <handle> [read flags]        Read bytes (raw by default, --hex to dump)
  write <handle>                    Write stdin bytes to the port
  signals <handle> get              Print control input signals
  signals <handle> set [sig flags]  Set control output signals
  console <handle> [--baud N]       Raw terminal on the port; C-a C-x quits

Open flags:
  --baud N (default 9600)  --data-bits N  --stop-bits N
  --parity none|even|odd   --flow-control none|hardware  --buffer-size N

Read flags:
  --bytes N        Stop after N bytes (default: ${LIMIT} cap)
  --until <hex>    Stop once this byte sequence is seen
  --timeout-ms N   Stop after N ms without data (default 1000, 0 for none)
  --hex            Hex-dump the bytes instead of emitting raw
  --follow         Stream until interrupted, with no cap and no timeout

Signal flags (set):
  --dtr on|off  --rts on|off  --break on|off

Console flags:
  --baud N (default 115200)

Options:
  --version
  -h, --help

Reads/writes are capped at ${LIMIT} bytes (4 MiB), except read --follow.
`;

export async function version(ctx) {
  const root = ctx.env.SLICC_PACKAGE;
  const raw = await ctx.fs.readFile(`${root}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

const OPEN = [
  '--baud',
  '--data-bits',
  '--stop-bits',
  '--parity',
  '--flow-control',
  '--buffer-size',
];
const SUBCOMMANDS = {
  list: { values: [], bools: [] },
  request: { values: ['--vid', '--pid'], bools: [] },
  open: { values: OPEN, bools: [] },
  close: { values: [], bools: [] },
  read: { values: ['--bytes', '--until', '--timeout-ms'], bools: ['--hex', '--follow'] },
  write: { values: [], bools: [] },
  signals: { values: ['--dtr', '--rts', '--break'], bools: [] },
  console: { values: ['--baud'], bools: [] },
};
const ALL = new Set(Object.values(SUBCOMMANDS).flatMap(({ values }) => values));
const PARITIES = ['none', 'even', 'odd'];
const FLOWS = ['none', 'hardware'];
const ESCAPE = 0x01;
const QUIT = 0x18;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Usage extends Error {}

export class Failure extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(args) {
  const positionals = [];
  const flags = new Map();
  const bools = new Set();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('-') && token !== '-') {
      if (ALL.has(token)) {
        if (i + 1 >= args.length) throw new Usage(`${token}: needs a value`);
        flags.set(token, args[++i]);
      } else bools.add(token);
    } else positionals.push(token);
  }
  return { positionals, flags, bools };
}

export function integer(value, label) {
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  throw new Usage(`invalid ${label}: '${value}'`);
}

export function parseHex(value) {
  const cleaned = value.replace(/0x/gi, '').replace(/[\s:,]/g, '');
  if (cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned))
    throw new Usage(`invalid hex string: '${value}'`);
  return cleaned.toLowerCase();
}

function parseBool(value, label) {
  const v = value.toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  throw new Usage(`invalid ${label}: '${value}' (use on/off)`);
}

function positive(flags, flag, label) {
  const n = integer(flags.get(flag), label);
  if (n < 1) throw new Usage(`invalid ${label}: '${flags.get(flag)}'`);
  return n;
}

export function filters(flags) {
  const filter = {};
  if (flags.has('--vid')) filter.usbVendorId = integer(flags.get('--vid'), 'vid');
  if (flags.has('--pid')) filter.usbProductId = integer(flags.get('--pid'), 'pid');
  for (const [key, value] of Object.entries(filter)) {
    if (value > 0xffff)
      throw new Usage(`invalid ${key === 'usbVendorId' ? 'vid' : 'pid'}: '${value}'`);
  }
  if (filter.usbProductId !== undefined && filter.usbVendorId === undefined)
    throw new Usage('request: --pid needs --vid');
  return Object.keys(filter).length ? [filter] : [];
}

export function openOptions(flags, baud = 9600) {
  const options = { baudRate: flags.has('--baud') ? positive(flags, '--baud', 'baud') : baud };
  if (flags.has('--data-bits')) {
    const bits = integer(flags.get('--data-bits'), 'data-bits');
    if (bits !== 7 && bits !== 8)
      throw new Usage(`invalid data-bits: '${flags.get('--data-bits')}' (use 7 or 8)`);
    options.dataBits = bits;
  }
  if (flags.has('--stop-bits')) {
    const bits = integer(flags.get('--stop-bits'), 'stop-bits');
    if (bits !== 1 && bits !== 2)
      throw new Usage(`invalid stop-bits: '${flags.get('--stop-bits')}' (use 1 or 2)`);
    options.stopBits = bits;
  }
  if (flags.has('--parity')) {
    const parity = flags.get('--parity');
    if (!PARITIES.includes(parity)) throw new Usage(`invalid --parity: '${parity}'`);
    options.parity = parity;
  }
  if (flags.has('--flow-control')) {
    const flow = flags.get('--flow-control');
    if (!FLOWS.includes(flow)) throw new Usage(`invalid --flow-control: '${flow}'`);
    options.flowControl = flow;
  }
  if (flags.has('--buffer-size'))
    options.bufferSize = positive(flags, '--buffer-size', 'buffer-size');
  return options;
}

export function readOptions(flags, bools) {
  if (bools.has('--follow')) {
    for (const flag of ['--bytes', '--until', '--timeout-ms']) {
      if (flags.has(flag)) throw new Usage(`read: --follow takes no ${flag}`);
    }
    return { follow: true };
  }
  const options = {};
  if (flags.has('--bytes')) {
    options.bytes = positive(flags, '--bytes', 'bytes');
    if (options.bytes > LIMIT) throw new Failure('read --bytes exceeds 4 MiB limit');
  }
  if (flags.has('--until')) {
    const until = parseHex(flags.get('--until'));
    if (until) options.until = until;
  }
  if (flags.has('--timeout-ms')) options.timeout = integer(flags.get('--timeout-ms'), 'timeout-ms');
  return options;
}

export function outputSignals(flags) {
  const signals = {};
  if (flags.has('--dtr')) signals.dataTerminalReady = parseBool(flags.get('--dtr'), 'dtr');
  if (flags.has('--rts')) signals.requestToSend = parseBool(flags.get('--rts'), 'rts');
  if (flags.has('--break')) signals.break = parseBool(flags.get('--break'), 'break');
  if (!Object.keys(signals).length) throw new Usage('signals set: needs --dtr, --rts or --break');
  return signals;
}

const hex4 = (n) => `0x${n.toString(16).padStart(4, '0')}`;

export function row(info) {
  let id = '(native serial)';
  if (info.usbVendorId !== undefined || info.usbProductId !== undefined)
    id = `${hex4(info.usbVendorId ?? 0)}:${hex4(info.usbProductId ?? 0)}`;
  else if (info.bluetoothServiceClassId !== undefined)
    id = `(bluetooth ${info.bluetoothServiceClassId})`;
  return `${info.handle}\t${id}${info.open ? ' [open]' : ''}${info.node ? `\t${info.node}` : ''}`;
}

export function signalLine(s) {
  return `cts=${s.clearToSend ? 1 : 0} dcd=${s.dataCarrierDetect ? 1 : 0} dsr=${s.dataSetReady ? 1 : 0} ri=${s.ringIndicator ? 1 : 0}\n`;
}

export function hexLine(bytes) {
  return `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`;
}

export function reason(error, kind) {
  const message = String(error?.message ?? error)
    .replace(/^[a-z][\w-]*: /, '')
    .replace(/: [A-Z][A-Z0-9]+$/, '');
  if (
    error?.code === 'ENOTSUP' &&
    /does not answer |no page answers /.test(message) &&
    !/^slicc-devices /.test(message)
  )
    return `needs seven's page (no page answers ${kind})`;
  if (error?.code === 'ENOENT' && /\/dev\/embedder/.test(message))
    return `needs seven's page (no page answers ${kind})`;
  return message;
}

export async function connect(ctx, kind, options = {}) {
  let file;
  try {
    file = await ctx.open('/dev/embedder', { read: true, write: true });
    await file.write(0, encoder.encode(`${JSON.stringify({ kind, ...options })}\n`));
  } catch (error) {
    await Promise.allSettled([file?.close()]);
    throw new Failure(reason(error, kind), error?.code);
  }
  const wrap = async (promise) => {
    try {
      return await promise;
    } catch (error) {
      throw new Failure(reason(error, kind), error?.code);
    }
  };
  return {
    send: (bytes) => wrap(file.write(0, bytes)),
    read: (max = 65536) => wrap(file.read(0, max)),
    close: () => Promise.allSettled([file.close()]),
  };
}

export async function ask(ctx, kind, options, body) {
  const request = await connect(ctx, kind, options);
  try {
    if (body?.length) await request.send(body);
    const parts = [];
    let size = 0;
    for (;;) {
      const chunk = await request.read();
      if (!chunk.length) break;
      parts.push(chunk);
      size += chunk.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return decoder.decode(out);
  } finally {
    await request.close();
  }
}

async function stdinBytes(ctx) {
  const parts = [];
  let size = 0;
  for (;;) {
    const chunk = await ctx.read(0, 65536);
    if (!chunk.length) break;
    size += chunk.length;
    if (size > LIMIT) throw new Failure('write payload exceeds 4 MiB limit');
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function needHandle(positionals, sub) {
  const handle = positionals[1];
  if (!handle) throw new Usage(`${sub}: handle required`);
  return handle;
}

async function list(ctx) {
  const ports = JSON.parse(await ask(ctx, 'serial.list'));
  if (!ports.length) return 'no granted serial ports\n';
  return `${ports.map(row).join('\n')}\n`;
}

async function read(ctx, handle, options, hex) {
  const request = await connect(ctx, 'serial.read', { handle, ...options });
  const held = [];
  try {
    for (;;) {
      const chunk = await request.read();
      if (!chunk.length) break;
      if (!hex) await ctx.write(1, chunk);
      else if (options.follow) await ctx.write(1, hexLine(chunk));
      else held.push(...chunk);
    }
  } finally {
    await request.close();
  }
  if (hex && held.length) await ctx.write(1, hexLine(held));
}

function sudoHint(ctx, error) {
  if (error.code !== 'EACCES' || !/is not allowed for this user/.test(error.message)) return error;
  return new Failure(
    `${error.message} (writes need root: sudo serial ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

export function keys(state, chunk) {
  for (const byte of chunk) {
    if (state.escaped) {
      state.escaped = false;
      if (byte === QUIT) {
        state.quit = true;
        return;
      }
      if (byte === ESCAPE) state.pending.push(byte);
    } else if (byte === ESCAPE) state.escaped = true;
    else state.pending.push(byte);
  }
}

function flusher(ctx, handle, state, say) {
  const flush = () => {
    if (state.busy || !state.pending.length || state.refused) return;
    const bytes = Uint8Array.from(state.pending);
    state.pending = [];
    state.busy = true;
    state.flying = ask(ctx, 'serial.write', { handle }, bytes)
      .catch(async (error) => {
        if (error.code !== 'EACCES') return say(error.message);
        await say(`writes need root: sudo serial console ${handle}`);
        state.refused = true;
        state.pending = [];
      })
      .finally(() => {
        state.busy = false;
        flush();
      });
  };
  return flush;
}

async function shown(ctx, follow, state, say, handle) {
  try {
    for (;;) {
      const chunk = await follow.read();
      if (!chunk.length) break;
      await ctx.write(1, chunk);
    }
    if (!state.quit) await say(`${handle} was closed`);
  } catch (error) {
    if (!state.quit) {
      state.status = 1;
      await say(error.message);
    }
  }
  state.quit = true;
}

async function typedIn(ctx, state, flush) {
  while (!state.quit) {
    const chunk = await ctx.read(0, 4096);
    if (!chunk.length || state.quit) break;
    keys(state, chunk);
    if (state.refused) state.pending = [];
    flush();
  }
  state.quit = true;
}

async function prepare(ctx, handle, flags) {
  if (!(await ctx.isatty(0))) throw new Usage('console: needs a terminal on stdin');
  const baud = openOptions(flags, 115200);
  const ports = JSON.parse(await ask(ctx, 'serial.list'));
  const port = ports.find((entry) => entry.handle === handle);
  if (!port) throw new Failure(`unknown serial handle '${handle}'`, 'ENOENT');
  if (port.open) return false;
  await ask(ctx, 'serial.open', { handle, ...baud });
  return true;
}

export async function consoleLoop(ctx, handle, flags) {
  const opened = await prepare(ctx, handle, flags);
  const say = (line) => ctx.write(2, `\r\nserial: ${line}\r\n`);
  await ctx.write(2, `serial: ${handle} (C-a C-x quits)\r\n`);
  await ctx.tty.setRaw(0, true);
  const follow = await connect(ctx, 'serial.read', { handle, follow: true });
  const state = {
    quit: false,
    status: 0,
    refused: false,
    escaped: false,
    pending: [],
    busy: false,
    flying: Promise.resolve(),
  };
  ctx.signals.on('SIGINT', () => {
    state.status = 130;
    state.quit = true;
    void follow.close();
  });
  const flush = flusher(ctx, handle, state, say);
  const output = shown(ctx, follow, state, say, handle);
  const input = typedIn(ctx, state, flush);
  await Promise.race([output, input]);
  await follow.close();
  await output;
  while (state.busy) await state.flying;
  await ctx.tty.setRaw(0, false);
  if (opened) await ask(ctx, 'serial.close', { handle }).catch(() => {});
  await ctx.write(2, '\n');
  return state.status;
}

async function dispatch(ctx, args) {
  const out = async (text) => {
    await ctx.write(1, text);
  };
  const { positionals, flags, bools } = parseArgs(args);
  const sub = positionals[0];
  const spec = SUBCOMMANDS[sub];
  if (!spec) throw new Usage(`unknown subcommand '${sub ?? ''}'`);
  for (const flag of flags.keys()) {
    if (!spec.values.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  for (const flag of bools) {
    if (!spec.bools.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  const most = { list: 1, request: 1, signals: 3 }[sub] ?? 2;
  if (positionals.length > most) throw new Usage(`${sub}: too many arguments`);
  if (sub === 'list') return out(await list(ctx));
  if (sub === 'request') {
    const port = JSON.parse(await ask(ctx, 'serial.request', { filters: filters(flags) }));
    return out(`${row(port)}\n`);
  }
  const handle = needHandle(positionals, sub);
  if (sub === 'open') return ask(ctx, 'serial.open', { handle, ...openOptions(flags) });
  if (sub === 'close') return ask(ctx, 'serial.close', { handle });
  if (sub === 'read') return read(ctx, handle, readOptions(flags, bools), bools.has('--hex'));
  if (sub === 'write') {
    const bytes = await stdinBytes(ctx);
    const count = await ask(ctx, 'serial.write', { handle }, bytes).catch((error) => {
      throw sudoHint(ctx, error);
    });
    return out(`${count} bytes written\n`);
  }
  if (sub === 'console') return consoleLoop(ctx, handle, flags);
  const action = positionals[2];
  if (action === 'get') {
    if (flags.size) throw new Usage('signals get: takes no flags');
    return out(signalLine(JSON.parse(await ask(ctx, 'serial.signals', { handle }))));
  }
  if (action === 'set') {
    return ask(ctx, 'serial.control', { handle, ...outputSignals(flags) }).catch((error) => {
      throw sudoHint(ctx, error);
    });
  }
  if (!action) throw new Usage('signals: handle and get|set required');
  throw new Usage(`signals: unknown action '${action}' (use get|set)`);
}

export default async function serial(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    await ctx.write(1, HELP);
    return 0;
  }
  try {
    if (args.includes('--version')) {
      if (args.length !== 1) throw new Usage('--version: takes no other arguments');
      await ctx.write(1, `${await version(ctx)}\n`);
      return 0;
    }
    const status = await dispatch(ctx, args);
    return typeof status === 'number' ? status : 0;
  } catch (error) {
    if (error instanceof Usage) {
      await ctx.write(2, `serial: ${error.message} (see serial --help)\n`);
      return 2;
    }
    await ctx.write(2, `serial: ${error.message}\n`);
    return 1;
  }
}
