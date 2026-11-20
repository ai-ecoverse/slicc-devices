export const LIMIT = 64 * 1024;

export const HELP = `midi - access MIDI ports via Web MIDI

Usage: midi <subcommand> [options]

Subcommands:
  request [--sysex]                 Ask the browser for MIDI access; prints ports
  list                              List MIDI ports (empty until midi request)
  open <handle>                     Open a port
  close <handle>                    Close a port
  receive <handle> [--count N] [--hex|--raw]
                                    Stream messages until Ctrl+C or N messages
  send <handle> [--hex HEX...]      Send MIDI bytes (stdin, or --hex)

Options:
  --sysex          request: allow system exclusive messages
  --hex            receive: hex dump (default); send: parse hex args
  --raw            receive: emit framed raw bytes
  --count <n>      receive: stop after n messages
  --version
  -h, --help

Sends are capped at ${LIMIT} bytes (64 KiB). Reads need the audio group;
sends need root (sudo midi send …). There is no Linux /dev/midi* node.
`;

export async function version(ctx) {
  const root = ctx.env.SLICC_PACKAGE;
  const raw = await ctx.fs.readFile(`${root}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

const SUBCOMMANDS = {
  list: { values: [], bools: [] },
  request: { values: [], bools: ['--sysex'] },
  open: { values: [], bools: [] },
  close: { values: [], bools: [] },
  receive: { values: ['--count'], bools: ['--hex', '--raw'] },
  send: { values: [], bools: ['--hex'] },
};
const ALL = new Set(Object.values(SUBCOMMANDS).flatMap(({ values }) => values));
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

export function parseHex(parts) {
  const text = parts
    .join(' ')
    .replace(/0x/gi, '')
    .replace(/[^0-9a-f]/gi, '');
  if (!text.length || text.length % 2) throw new Usage('send --hex: needs complete hex bytes');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
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
      throw new Failure(`malformed MIDI sysex at offset ${at}: status byte inside sysex`);
    end += 1;
  }
  if (end >= bytes.byteLength)
    throw new Failure(`malformed MIDI sysex at offset ${at}: missing F7`);
  return end + 1;
}

function shortEnd(bytes, at, status) {
  const need = dataLength(status);
  if (need < 0)
    throw new Failure(
      `malformed MIDI message at offset ${at}: bad status 0x${status.toString(16)}`
    );
  if (at + 1 + need > bytes.byteLength)
    throw new Failure(`malformed MIDI message at offset ${at}: truncated`);
  for (let i = 1; i <= need; i++) {
    if (bytes[at + i] >= 0x80)
      throw new Failure(`malformed MIDI message at offset ${at}: data byte has high bit`);
  }
  return at + 1 + need;
}

export function validateMessages(bytes) {
  let at = 0;
  while (at < bytes.byteLength) {
    const status = bytes[at];
    if (status < 0x80)
      throw new Failure(`malformed MIDI message at offset ${at}: missing status byte`);
    at = status === 0xf0 ? sysexEnd(bytes, at) : shortEnd(bytes, at, status);
  }
  return bytes;
}

export function row(info) {
  const name = info.name || info.id || '(unknown)';
  const who = info.manufacturer ? `${info.manufacturer} ${name}` : name;
  const kind = info.type === 'input' ? 'in' : 'out';
  const state = info.connection === 'open' || info.opened ? ' [open]' : '';
  const gone = info.state === 'disconnected' ? ' [disconnected]' : '';
  return `${info.handle}\t${kind}\t${who}${state}${gone}`;
}

export function hexLine(bytes) {
  return bytes.length
    ? `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`
    : '';
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
    return out;
  } finally {
    await request.close();
  }
}

async function askText(ctx, kind, options, body) {
  return decoder.decode(await ask(ctx, kind, options, body));
}

async function stdinBytes(ctx) {
  const parts = [];
  let size = 0;
  for (;;) {
    const chunk = await ctx.read(0, 65536);
    if (!chunk.length) break;
    size += chunk.length;
    if (size > LIMIT) throw new Failure('send payload exceeds 64 KiB limit');
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

function sudoHint(ctx, error) {
  if (error.code !== 'EACCES' || !/is not allowed for this user/.test(error.message)) return error;
  return new Failure(
    `${error.message} (needs root: sudo midi ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

async function list(ctx) {
  const ports = JSON.parse(await askText(ctx, 'midi.list'));
  if (!ports.length) {
    await ctx.write(2, 'midi: no MIDI ports (midi request)\n');
    return '';
  }
  return `${ports.map(row).join('\n')}\n`;
}

async function rooted(ctx, work) {
  try {
    return await work();
  } catch (error) {
    throw sudoHint(ctx, error);
  }
}

async function runReceive(ctx, handle, flags, bools) {
  const count = flags.has('--count') ? integer(flags.get('--count'), 'count') : Infinity;
  if (count !== Infinity && count < 1) throw new Usage(`invalid count: '${flags.get('--count')}'`);
  const raw = bools.has('--raw') && !bools.has('--hex');
  const request = await connect(ctx, 'midi.receive', { handle });
  const state = { status: 0, seen: 0, pending: new Uint8Array(0) };
  const onSig = () => {
    state.status = 130;
    void request.close();
  };
  ctx.signals.on('SIGINT', onSig);
  try {
    for (;;) {
      if (state.status === 130) break;
      const chunk = await request.read();
      if (!chunk.length) break;
      const joined = new Uint8Array(state.pending.length + chunk.length);
      joined.set(state.pending);
      joined.set(chunk, state.pending.length);
      let offset = 0;
      for (;;) {
        const frame = readFrame(joined, offset);
        if (!frame) {
          state.pending = joined.subarray(offset);
          break;
        }
        offset = frame.next;
        state.seen += 1;
        if (raw) await ctx.write(1, frameMessage(frame.timestamp, frame.bytes));
        else await ctx.write(1, hexLine(frame.bytes));
        if (state.seen >= count) break;
      }
      if (state.seen >= count) break;
    }
  } catch (error) {
    if (state.status === 130) return 130;
    throw error;
  } finally {
    ctx.signals.off?.('SIGINT', onSig);
    await request.close().catch(() => {});
  }
  return state.status;
}

function frameMessage(timestamp, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(12 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setFloat64(0, Number(timestamp) || 0, true);
  view.setUint32(8, bytes.byteLength, true);
  out.set(bytes, 12);
  return out;
}

export { frameMessage as frameMidiMessage };

async function runSend(ctx, handle, positionals, bools) {
  let bytes;
  if (bools.has('--hex')) {
    const parts = positionals.slice(2);
    if (!parts.length) throw new Usage('send --hex: needs hex bytes');
    bytes = parseHex(parts);
  } else {
    if (positionals.length > 2) throw new Usage('send: too many arguments');
    bytes = await stdinBytes(ctx);
  }
  if (bytes.length > LIMIT) throw new Failure('send payload exceeds 64 KiB limit');
  validateMessages(bytes);
  await rooted(ctx, () => ask(ctx, 'midi.send', { handle }, bytes));
}

const MOST = {
  list: 1,
  request: 1,
  open: 2,
  close: 2,
  receive: 2,
  send: Infinity,
};

async function dispatch(ctx, args) {
  const { positionals, flags, bools } = parseArgs(args);
  const sub = positionals[0];
  const spec = SUBCOMMANDS[sub];
  if (!spec) throw new Usage(`unknown subcommand '${sub ?? ''}'`);
  for (const flag of flags.keys()) {
    if (!spec.values.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  for (const flag of bools) {
    if (!spec.bools.includes(flag) && !(sub === 'send' && flag === '--hex'))
      throw new Usage(`${sub}: unknown option ${flag}`);
  }
  if (sub !== 'send' && positionals.length > (MOST[sub] ?? 2))
    throw new Usage(`${sub}: too many arguments`);
  if (sub === 'list') {
    await ctx.write(1, await list(ctx));
    return;
  }
  if (sub === 'request') {
    const ports = JSON.parse(
      await askText(ctx, 'midi.request', { sysex: bools.has('--sysex') || undefined })
    );
    if (!ports.length) return;
    await ctx.write(1, `${ports.map(row).join('\n')}\n`);
    return;
  }
  const handle = needHandle(positionals, sub);
  if (sub === 'open') return ask(ctx, 'midi.open', { handle });
  if (sub === 'close') return ask(ctx, 'midi.close', { handle });
  if (sub === 'receive') return runReceive(ctx, handle, flags, bools);
  return runSend(ctx, handle, positionals, bools);
}

export default async function midi(ctx) {
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
      await ctx.write(2, `midi: ${error.message} (see midi --help)\n`);
      return 2;
    }
    await ctx.write(2, `midi: ${error.message}\n`);
    return 1;
  }
}
