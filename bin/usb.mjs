export const LIMIT = 4 * 1024 * 1024;

export const HELP = `usb - access USB devices via WebUSB

Usage: usb <subcommand> [options]

Subcommands:
  list                              List currently-granted devices
  request [--vid 0x.. --pid 0x.. --class N --subclass N --protocol N --serial S]
                                    Open the device picker; prints a handle
  open <handle>                     Open a device
  close <handle> [--force]          Close a device
  reset <handle> [--force]          Reset a device
  clear-halt <handle> <in|out> <endpoint>
                                    Clear a stalled endpoint
  select-config <handle> <value>    Select a configuration
  claim <handle> <interface> [--wait]
                                    Claim an interface
  release <handle> <interface>      Release an interface
  control-in <handle> <length> [setup flags]
  control-out <handle> [setup flags]            (payload from stdin)
  transfer-in <handle> <endpoint> <length> [--raw] [--follow]
  transfer-out <handle> <endpoint>              (payload from stdin)

Control setup flags:
  --request-type standard|class|vendor   (default vendor)
  --recipient device|interface|endpoint|other (default device)
  --request N  --value N  --index N

Options:
  --force   Close/reset even if another consumer holds a claim
  --wait    Queue a claim until the current holder releases
  --raw     Emit raw bytes for *-in transfers (default: hex dump)
  --follow  Stream repeated transfer-in until interrupted
  --version
  -h, --help

Transfers are capped at ${LIMIT} bytes (4 MiB).
`;

export async function version(ctx) {
  const root = ctx.env.SLICC_PACKAGE;
  const raw = await ctx.fs.readFile(`${root}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

const REQUEST = ['--vid', '--pid', '--class', '--subclass', '--protocol', '--serial'];
const SETUP = ['--request-type', '--recipient', '--request', '--value', '--index'];
const SUBCOMMANDS = {
  list: { values: [], bools: [] },
  request: { values: REQUEST, bools: [] },
  open: { values: [], bools: [] },
  close: { values: [], bools: ['--force'] },
  reset: { values: [], bools: ['--force'] },
  'clear-halt': { values: [], bools: [] },
  'select-config': { values: [], bools: [] },
  claim: { values: [], bools: ['--wait'] },
  release: { values: [], bools: [] },
  'control-in': { values: SETUP, bools: ['--raw'] },
  'control-out': { values: SETUP, bools: [] },
  'transfer-in': { values: [], bools: ['--raw', '--follow'] },
  'transfer-out': { values: [], bools: [] },
};
const ALL = new Set(Object.values(SUBCOMMANDS).flatMap(({ values }) => values));
const REQUEST_TYPES = ['standard', 'class', 'vendor'];
const RECIPIENTS = ['device', 'interface', 'endpoint', 'other'];
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

export function filters(flags) {
  const filter = {};
  if (flags.has('--vid')) filter.vendorId = integer(flags.get('--vid'), 'vid');
  if (flags.has('--pid')) filter.productId = integer(flags.get('--pid'), 'pid');
  if (flags.has('--class')) filter.classCode = integer(flags.get('--class'), 'class');
  if (flags.has('--subclass')) filter.subclassCode = integer(flags.get('--subclass'), 'subclass');
  if (flags.has('--protocol')) filter.protocolCode = integer(flags.get('--protocol'), 'protocol');
  if (flags.has('--serial')) filter.serialNumber = flags.get('--serial');
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'serialNumber') continue;
    if ((key === 'vendorId' || key === 'productId') && value > 0xffff)
      throw new Usage(`invalid ${key === 'vendorId' ? 'vid' : 'pid'}: '${value}'`);
  }
  if (filter.productId !== undefined && filter.vendorId === undefined)
    throw new Usage('request: --pid needs --vid');
  return Object.keys(filter).length ? [filter] : [];
}

export function controlSetup(flags) {
  const requestType = flags.get('--request-type') ?? 'vendor';
  const recipient = flags.get('--recipient') ?? 'device';
  if (!REQUEST_TYPES.includes(requestType))
    throw new Usage(`invalid --request-type: '${requestType}'`);
  if (!RECIPIENTS.includes(recipient)) throw new Usage(`invalid --recipient: '${recipient}'`);
  return {
    requestType,
    recipient,
    request: integer(flags.get('--request') ?? '0', 'request'),
    value: integer(flags.get('--value') ?? '0', 'value'),
    index: integer(flags.get('--index') ?? '0', 'index'),
  };
}

const hex4 = (n) => `0x${n.toString(16).padStart(4, '0')}`;

export function row(info) {
  const name = [info.manufacturerName, info.productName].filter(Boolean).join(' ') || '(unknown)';
  const serial = info.serialNumber ? ` serial=${info.serialNumber}` : '';
  const state = info.opened ? ' [open]' : '';
  return `${info.handle}\t${hex4(info.vendorId)}:${hex4(info.productId)}\t${name}${serial}${state}`;
}

export function hexLine(bytes) {
  return bytes.length
    ? `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`
    : '';
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
    if (size > LIMIT) throw new Failure('transfer-out payload exceeds 4 MiB limit');
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
    `${error.message} (needs root: sudo usb ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

async function list(ctx) {
  const devices = JSON.parse(await askText(ctx, 'usb.list'));
  if (!devices.length) return 'no granted USB devices\n';
  return `${devices.map(row).join('\n')}\n`;
}

async function emitIn(ctx, bytes, raw) {
  if (raw) await ctx.write(1, bytes);
  else await ctx.write(1, hexLine(bytes));
}

async function transferIn(ctx, handle, endpoint, length, raw, follow) {
  const options = { handle, endpoint, length, ...(follow ? { follow: true } : {}) };
  const request = await connect(ctx, 'usb.transfer.in', options);
  const held = [];
  try {
    for (;;) {
      const chunk = await request.read();
      if (!chunk.length) break;
      if (raw) await ctx.write(1, chunk);
      else if (follow) await ctx.write(1, hexLine(chunk));
      else held.push(...chunk);
    }
  } finally {
    await request.close();
  }
  if (!raw && !follow && held.length) await ctx.write(1, hexLine(Uint8Array.from(held)));
}

async function rooted(ctx, work) {
  try {
    return await work();
  } catch (error) {
    throw sudoHint(ctx, error);
  }
}

async function runClearHalt(ctx, handle, positionals) {
  const direction = positionals[2];
  const endpoint = positionals[3];
  if (!direction || endpoint === undefined)
    throw new Usage('clear-halt: handle, direction and endpoint required');
  if (direction !== 'in' && direction !== 'out')
    throw new Usage(`clear-halt: direction must be 'in' or 'out', got '${direction}'`);
  return rooted(ctx, () =>
    ask(ctx, 'usb.clear-halt', {
      handle,
      direction,
      endpoint: integer(endpoint, 'endpoint'),
    })
  );
}

async function runSelect(ctx, handle, positionals) {
  const value = positionals[2];
  if (value === undefined) throw new Usage('select-config: handle and value required');
  return rooted(ctx, () =>
    ask(ctx, 'usb.select', {
      handle,
      configuration: integer(value, 'configuration'),
    })
  );
}

async function runClaim(ctx, handle, positionals, bools) {
  const iface = positionals[2];
  if (iface === undefined) throw new Usage('claim: handle and interface required');
  return ask(ctx, 'usb.claim', {
    handle,
    interface: integer(iface, 'interface'),
    ...(bools.has('--wait') ? { wait: true } : {}),
  });
}

async function runRelease(ctx, handle, positionals) {
  const iface = positionals[2];
  if (iface === undefined) throw new Usage('release: handle and interface required');
  return ask(ctx, 'usb.release', {
    handle,
    interface: integer(iface, 'interface'),
  });
}

async function runControlIn(ctx, handle, positionals, flags, bools) {
  const lengthStr = positionals[2];
  if (lengthStr === undefined) throw new Usage('control-in: handle and length required');
  const length = integer(lengthStr, 'length');
  if (length > LIMIT) throw new Failure('control-in length exceeds 4 MiB limit');
  const bytes = await rooted(ctx, () =>
    ask(ctx, 'usb.control', { handle, length, ...controlSetup(flags) })
  );
  return emitIn(ctx, bytes, bools.has('--raw'));
}

async function runControlOut(ctx, handle, flags) {
  const bytes = await stdinBytes(ctx);
  if (bytes.length > LIMIT) throw new Failure('control-out payload exceeds 4 MiB limit');
  const count = await rooted(ctx, () =>
    askText(ctx, 'usb.control', { handle, ...controlSetup(flags) }, bytes)
  );
  await ctx.write(1, `${count} bytes written\n`);
}

async function runTransferIn(ctx, handle, positionals, bools) {
  const epStr = positionals[2];
  const lengthStr = positionals[3];
  if (epStr === undefined || lengthStr === undefined)
    throw new Usage('transfer-in: handle, endpoint and length required');
  const length = integer(lengthStr, 'length');
  if (length > LIMIT) throw new Failure('transfer-in length exceeds 4 MiB limit');
  return transferIn(
    ctx,
    handle,
    integer(epStr, 'endpoint'),
    length,
    bools.has('--raw'),
    bools.has('--follow')
  );
}

async function runTransferOut(ctx, handle, positionals) {
  const epStr = positionals[2];
  if (epStr === undefined) throw new Usage('transfer-out: handle and endpoint required');
  const bytes = await stdinBytes(ctx);
  const count = await rooted(ctx, () =>
    askText(ctx, 'usb.transfer.out', { handle, endpoint: integer(epStr, 'endpoint') }, bytes)
  );
  await ctx.write(1, `${count} bytes written\n`);
}

const MOST = {
  list: 1,
  request: 1,
  'clear-halt': 4,
  'select-config': 3,
  claim: 3,
  release: 3,
  'control-in': 3,
  'control-out': 2,
  'transfer-in': 4,
  'transfer-out': 3,
};

async function run(ctx, sub, handle, positionals, flags, bools) {
  if (sub === 'open') return ask(ctx, 'usb.open', { handle });
  if (sub === 'close')
    return ask(ctx, 'usb.close', { handle, ...(bools.has('--force') ? { force: true } : {}) });
  if (sub === 'reset')
    return rooted(ctx, () =>
      ask(ctx, 'usb.reset', { handle, ...(bools.has('--force') ? { force: true } : {}) })
    );
  if (sub === 'clear-halt') return runClearHalt(ctx, handle, positionals);
  if (sub === 'select-config') return runSelect(ctx, handle, positionals);
  if (sub === 'claim') return runClaim(ctx, handle, positionals, bools);
  if (sub === 'release') return runRelease(ctx, handle, positionals);
  if (sub === 'control-in') return runControlIn(ctx, handle, positionals, flags, bools);
  if (sub === 'control-out') return runControlOut(ctx, handle, flags);
  if (sub === 'transfer-in') return runTransferIn(ctx, handle, positionals, bools);
  return runTransferOut(ctx, handle, positionals);
}

async function dispatch(ctx, args) {
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
  if (positionals.length > (MOST[sub] ?? 2)) throw new Usage(`${sub}: too many arguments`);
  if (sub === 'list') {
    await ctx.write(1, await list(ctx));
    return;
  }
  if (sub === 'request') {
    const device = JSON.parse(await askText(ctx, 'usb.request', { filters: filters(flags) }));
    await ctx.write(1, `${row(device)}\n`);
    return;
  }
  return run(ctx, sub, needHandle(positionals, sub), positionals, flags, bools);
}

export default async function usb(ctx) {
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
      await ctx.write(2, `usb: ${error.message} (see usb --help)\n`);
      return 2;
    }
    await ctx.write(2, `usb: ${error.message}\n`);
    return 1;
  }
}
