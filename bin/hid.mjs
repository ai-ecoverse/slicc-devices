export const LIMIT = 64 * 1024;
export const DEFAULT_QUERY_TIMEOUT_MS = 1000;

export const HELP = `hid - access HID devices via WebHID

Usage: hid <subcommand> [options]

Subcommands:
  list                              List currently-granted devices
  request [--vid 0x.. --pid 0x.. --usage-page N --usage N]
                                    Open the device picker; prints a handle
  open <handle>                     Open a device
  close <handle>                    Close a device
  send <handle> <report-id>         Send an output report (payload from stdin)
  query <handle> <report-id>        Send an output report and await one input
                                    report (VIA-style request/response)
  feature-send <handle> <report-id> Send a feature report (payload from stdin)
  feature-get <handle> <report-id> [length]
                                    Receive a feature report
  watch <handle>                    Stream input reports as hex until Ctrl+C

Options:
  --raw            Emit raw bytes (feature-get, query); default is hex dump
  --timeout <ms>   query: wait this long for an input report (default 1000)
  --version
  -h, --help

Report payloads are capped at ${LIMIT} bytes (64 KiB).
`;

export async function version(ctx) {
  const root = ctx.env.SLICC_PACKAGE;
  const raw = await ctx.fs.readFile(`${root}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

const REQUEST = ['--vid', '--pid', '--usage-page', '--usage'];
const SUBCOMMANDS = {
  list: { values: [], bools: [] },
  request: { values: REQUEST, bools: [] },
  open: { values: [], bools: [] },
  close: { values: [], bools: [] },
  send: { values: [], bools: [] },
  query: { values: ['--timeout'], bools: ['--raw'] },
  'feature-send': { values: [], bools: [] },
  'feature-get': { values: [], bools: ['--raw'] },
  watch: { values: [], bools: [] },
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

export function filters(flags) {
  const filter = {};
  if (flags.has('--vid')) filter.vendorId = integer(flags.get('--vid'), 'vid');
  if (flags.has('--pid')) filter.productId = integer(flags.get('--pid'), 'pid');
  if (flags.has('--usage-page'))
    filter.usagePage = integer(flags.get('--usage-page'), 'usage-page');
  if (flags.has('--usage')) filter.usage = integer(flags.get('--usage'), 'usage');
  for (const [key, value] of Object.entries(filter)) {
    if ((key === 'vendorId' || key === 'productId') && value > 0xffff)
      throw new Usage(`invalid ${key === 'vendorId' ? 'vid' : 'pid'}: '${value}'`);
  }
  if (filter.productId !== undefined && filter.vendorId === undefined)
    throw new Usage('request: --pid needs --vid');
  return Object.keys(filter).length ? [filter] : [];
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hex4 = (n) => `0x${n.toString(16).padStart(4, '0')}`;

export function row(info) {
  const name = info.productName || '(unknown)';
  const state = info.opened ? ' [open]' : '';
  const usage =
    info.usagePage !== undefined ? `\t${hex4(info.usagePage)}:${hex4(info.usage ?? 0)}` : '';
  return `${info.handle}\t${hex4(info.vendorId)}:${hex4(info.productId)}${usage}\t${name}${state}`;
}

export function pickPrimaryAndOrder(devices, filter) {
  const wantPage = filter?.usagePage;
  const wantUsage = filter?.usage;
  if (wantPage === undefined && wantUsage === undefined) return devices;
  const matchIdx = devices.findIndex(
    (d) =>
      (wantPage === undefined || d.usagePage === wantPage) &&
      (wantUsage === undefined || d.usage === wantUsage)
  );
  if (matchIdx <= 0) return devices;
  const out = devices.slice();
  const [match] = out.splice(matchIdx, 1);
  out.unshift(match);
  return out;
}

export function hexLine(bytes) {
  return bytes.length
    ? `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`
    : '';
}

export function formatReport(reportId, bytes) {
  return `${hex2(reportId)} ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}`.trimEnd();
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
    `${error.message} (needs root: sudo hid ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

async function list(ctx) {
  const devices = JSON.parse(await askText(ctx, 'hid.list'));
  if (!devices.length) return 'no granted HID devices\n';
  return `${devices.map(row).join('\n')}\n`;
}

async function emitBytes(ctx, bytes, raw) {
  if (raw) await ctx.write(1, bytes);
  else await ctx.write(1, hexLine(bytes));
}

async function rooted(ctx, work) {
  try {
    return await work();
  } catch (error) {
    throw sudoHint(ctx, error);
  }
}

async function runWatch(ctx, handle) {
  const request = await connect(ctx, 'hid.watch', { handle });
  const state = { status: 0 };
  const onSig = () => {
    state.status = 130;
    void request.close();
  };
  ctx.signals.on('SIGINT', onSig);
  try {
    for (;;) {
      const chunk = await request.read();
      if (!chunk.length) break;
      const reportId = chunk[0];
      const bytes = chunk.subarray(1);
      await ctx.write(1, `${formatReport(reportId, bytes)}\n`);
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

async function runQuery(ctx, handle, reportId, flags, raw) {
  const bytes = await stdinBytes(ctx);
  if (bytes.length > LIMIT) throw new Failure('query payload exceeds 64 KiB limit');
  const timeoutMs = flags.has('--timeout')
    ? integer(flags.get('--timeout'), 'timeout')
    : DEFAULT_QUERY_TIMEOUT_MS;
  const request = await connect(ctx, 'hid.watch', { handle });
  let timer;
  try {
    await rooted(ctx, () => ask(ctx, 'hid.send', { handle, reportId }, bytes));
    const report = await Promise.race([
      (async () => {
        for (;;) {
          const chunk = await request.read();
          if (!chunk.length) return null;
          return { reportId: chunk[0], bytes: chunk.subarray(1) };
        }
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (report === 'timeout' || report === null)
      throw new Failure(`query: no input report within ${timeoutMs}ms`);
    if (raw) await ctx.write(1, report.bytes);
    else await ctx.write(1, `${formatReport(report.reportId, report.bytes)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await request.close();
  }
}

async function runSend(ctx, sub, handle, reportId) {
  const bytes = await stdinBytes(ctx);
  const kind = sub === 'send' ? 'hid.send' : 'hid.send-feature';
  await rooted(ctx, () => ask(ctx, kind, { handle, reportId }, bytes));
}

async function runFeatureGet(ctx, handle, reportId, raw) {
  const bytes = await rooted(ctx, () => ask(ctx, 'hid.receive-feature', { handle, reportId }));
  return emitBytes(ctx, bytes, raw);
}

const MOST = {
  list: 1,
  request: 1,
  send: 3,
  query: 3,
  'feature-send': 3,
  'feature-get': 4,
  watch: 2,
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
    if (!spec.bools.includes(flag)) throw new Usage(`${sub}: unknown option ${flag}`);
  }
  if (positionals.length > (MOST[sub] ?? 2)) throw new Usage(`${sub}: too many arguments`);
  if (sub === 'list') {
    await ctx.write(1, await list(ctx));
    return;
  }
  if (sub === 'request') {
    const filter = filters(flags)[0];
    const devices = JSON.parse(await askText(ctx, 'hid.request', { filters: filters(flags) }));
    const ordered = pickPrimaryAndOrder(devices, filter);
    await ctx.write(1, `${ordered.map(row).join('\n')}\n`);
    return;
  }
  const handle = needHandle(positionals, sub);
  if (sub === 'open') return ask(ctx, 'hid.open', { handle });
  if (sub === 'close') return ask(ctx, 'hid.close', { handle });
  if (sub === 'watch') return runWatch(ctx, handle);
  if (sub === 'send' || sub === 'feature-send' || sub === 'query' || sub === 'feature-get') {
    const reportIdStr = positionals[2];
    if (reportIdStr === undefined) throw new Usage(`${sub}: handle and report-id required`);
    const reportId = integer(reportIdStr, 'report-id');
    if (sub === 'feature-get') return runFeatureGet(ctx, handle, reportId, bools.has('--raw'));
    if (sub === 'query') return runQuery(ctx, handle, reportId, flags, bools.has('--raw'));
    return runSend(ctx, sub, handle, reportId);
  }
}

export default async function hid(ctx) {
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
      await ctx.write(2, `hid: ${error.message} (see hid --help)\n`);
      return 2;
    }
    await ctx.write(2, `hid: ${error.message}\n`);
    return 1;
  }
}
