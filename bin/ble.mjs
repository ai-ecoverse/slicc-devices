export const LIMIT = 512;

export const HELP = `ble - access Bluetooth LE devices via Web Bluetooth

Usage: ble <subcommand> [options]

Subcommands:
  list                              List devices this page can use
  request [--service name|uuid]... [--name N] [--name-prefix P] [--all]
                                    Open the device picker; prints a handle
  connect <handle>                  Connect to the device's GATT server
  disconnect <handle>               Disconnect
  services <handle>                 List primary services as JSON
  read <handle> <service> <characteristic> [--descriptor D] [--hex|--raw]
                                    Read a characteristic or descriptor value
  write <handle> <service> <characteristic> [--no-response]
                                    Write bytes from stdin (at most 512)
  notify <handle> <service> <characteristic> [--count N] [--hex]
                                    Stream notifications until Ctrl+C

Options:
  --service <name|uuid>   request: filter and optionalServices (repeatable)
  --name <n>              request: exact advertised name
  --name-prefix <p>       request: advertised name prefix
  --all                   request: acceptAllDevices (no filters)
  --hex                   read/notify: hex dump (default for notify)
  --raw                   read: emit raw bytes
  --no-response           write: writeValueWithoutResponse
  --count <n>             notify: stop after n values
  --version
  -h, --help

GATT writes are capped at ${LIMIT} bytes. Reads need the bluetooth group;
writes need root (sudo ble write …).
`;

export async function version(ctx) {
  const root = ctx.env.SLICC_PACKAGE;
  const raw = await ctx.fs.readFile(`${root}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

const REQUEST = ['--service', '--name', '--name-prefix'];
const SUBCOMMANDS = {
  list: { values: [], bools: [] },
  request: { values: REQUEST, bools: ['--all'] },
  connect: { values: [], bools: [] },
  disconnect: { values: [], bools: [] },
  services: { values: [], bools: [] },
  read: { values: ['--descriptor'], bools: ['--hex', '--raw'] },
  write: { values: [], bools: ['--no-response'] },
  notify: { values: ['--count'], bools: ['--hex'] },
};
const ALL = new Set([...Object.values(SUBCOMMANDS).flatMap(({ values }) => values), '--service']);
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
  const multi = new Map();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('-') && token !== '-') {
      if (token === '--service') {
        if (i + 1 >= args.length) throw new Usage(`${token}: needs a value`);
        const list = multi.get(token) ?? [];
        list.push(args[++i]);
        multi.set(token, list);
        flags.set(token, list[list.length - 1]);
      } else if (
        ALL.has(token) &&
        token !== '--all' &&
        token !== '--hex' &&
        token !== '--raw' &&
        token !== '--no-response'
      ) {
        if (i + 1 >= args.length) throw new Usage(`${token}: needs a value`);
        flags.set(token, args[++i]);
      } else bools.add(token);
    } else positionals.push(token);
  }
  return { positionals, flags, bools, multi };
}

export function integer(value, label) {
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  throw new Usage(`invalid ${label}: '${value}'`);
}

export function requestOptions(flags, bools, multi) {
  const services = multi.get('--service') ?? [];
  const filters = [];
  const filter = {};
  if (services.length) filter.services = services;
  if (flags.has('--name')) filter.name = flags.get('--name');
  if (flags.has('--name-prefix')) filter.namePrefix = flags.get('--name-prefix');
  if (Object.keys(filter).length) filters.push(filter);
  const out = {};
  if (bools.has('--all')) {
    if (filters.length && (filter.name || filter.namePrefix || filter.services)) {
      if (filter.name || filter.namePrefix)
        throw new Usage('request: --all cannot be combined with --name or --name-prefix');
    }
    out.acceptAllDevices = true;
    if (services.length) out.optionalServices = services;
  } else {
    if (!filters.length)
      throw new Usage('request: needs --service, --name, --name-prefix or --all');
    out.filters = filters;
    if (services.length) out.optionalServices = services;
  }
  return out;
}

export function row(info) {
  const name = info.name || info.id || '(unknown)';
  const state = info.connected ? ' [connected]' : '';
  return `${info.handle}  ${name}${state}`;
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
    if (size > LIMIT) throw new Failure('a BLE write is at most 512 bytes');
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
    `${error.message} (needs root: sudo ble ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

async function list(ctx) {
  const devices = JSON.parse(await askText(ctx, 'ble.list'));
  if (!devices.length) return 'no Bluetooth devices\n';
  return `${devices.map(row).join('\n')}\n`;
}

async function rooted(ctx, work) {
  try {
    return await work();
  } catch (error) {
    throw sudoHint(ctx, error);
  }
}

async function runNotify(ctx, handle, service, characteristic, flags, bools) {
  const count = flags.has('--count') ? integer(flags.get('--count'), 'count') : Infinity;
  if (count !== Infinity && count < 1) throw new Usage(`invalid count: '${flags.get('--count')}'`);
  const request = await connect(ctx, 'ble.notify', { handle, service, characteristic });
  const state = { status: 0, seen: 0 };
  const onSig = () => {
    state.status = 130;
    void request.close();
  };
  ctx.signals.on('SIGINT', onSig);
  try {
    for (;;) {
      const chunk = await request.read();
      if (!chunk.length) break;
      state.seen += 1;
      await ctx.write(1, hexLine(chunk));
      if (state.seen >= count) {
        await request.close();
        break;
      }
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

const MOST = {
  list: 1,
  request: 1,
  connect: 2,
  disconnect: 2,
  services: 2,
  read: 4,
  write: 4,
  notify: 4,
};

function checkFlags(sub, spec, flags, bools, multi) {
  for (const flag of flags.keys()) {
    if (flag === '--service') continue;
    if (!spec.values.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  for (const flag of bools) {
    if (!spec.bools.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  if (multi.has('--service') && sub !== 'request')
    throw new Usage(`${sub}: unknown option --service`);
}

async function runRead(ctx, handle, service, characteristic, flags, bools) {
  const options = { handle, service, characteristic };
  if (flags.has('--descriptor')) options.descriptor = flags.get('--descriptor');
  const bytes = await ask(ctx, 'ble.read', options);
  if (bools.has('--raw') && !bools.has('--hex')) await ctx.write(1, bytes);
  else await ctx.write(1, hexLine(bytes));
}

async function runWrite(ctx, handle, service, characteristic, bools) {
  const bytes = await stdinBytes(ctx);
  await rooted(ctx, () =>
    ask(
      ctx,
      'ble.write',
      { handle, service, characteristic, noResponse: bools.has('--no-response') },
      bytes
    )
  );
}

async function runGatt(ctx, sub, handle, positionals, flags, bools) {
  const service = positionals[2];
  const characteristic = positionals[3];
  if (!service || !characteristic)
    throw new Usage(`${sub}: handle, service and characteristic required`);
  if (sub === 'read') return runRead(ctx, handle, service, characteristic, flags, bools);
  if (sub === 'write') return runWrite(ctx, handle, service, characteristic, bools);
  return runNotify(ctx, handle, service, characteristic, flags, bools);
}

async function dispatch(ctx, args) {
  const { positionals, flags, bools, multi } = parseArgs(args);
  const sub = positionals[0];
  const spec = SUBCOMMANDS[sub];
  if (!spec) throw new Usage(`unknown subcommand '${sub ?? ''}'`);
  checkFlags(sub, spec, flags, bools, multi);
  if (positionals.length > (MOST[sub] ?? 2)) throw new Usage(`${sub}: too many arguments`);
  if (sub === 'list') {
    await ctx.write(1, await list(ctx));
    return;
  }
  if (sub === 'request') {
    const options = requestOptions(flags, bools, multi);
    const device = JSON.parse(await askText(ctx, 'ble.request', options));
    await ctx.write(1, `${row(device)}\n`);
    return;
  }
  const handle = needHandle(positionals, sub);
  if (sub === 'connect') return ask(ctx, 'ble.connect', { handle });
  if (sub === 'disconnect') return ask(ctx, 'ble.disconnect', { handle });
  if (sub === 'services') {
    await ctx.write(1, `${await askText(ctx, 'ble.services', { handle })}\n`);
    return;
  }
  return runGatt(ctx, sub, handle, positionals, flags, bools);
}

export default async function ble(ctx) {
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
      await ctx.write(2, `ble: ${error.message} (see ble --help)\n`);
      return 2;
    }
    await ctx.write(2, `ble: ${error.message}\n`);
    return 1;
  }
}
