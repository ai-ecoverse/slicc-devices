export const FLASH_LIMIT = 16 * 1024 * 1024;
export const SECTOR = 4096;
export const DEFAULT_BAUD = 115200;

export const HELP = `esptool - flash ESP32 / ESP8266 chips via esptool-js

Usage: esptool [--port H] [--baud N] <subcommand> [args]

Subcommands:
  chip_id                            Detect the chip and print its variant + MAC
  read_mac                           Print the factory MAC address
  flash_id                           Print manufacturer / device id / detected size
  read_reg <addr>                    Print a 32-bit register value (hex)
  read_flash <addr> <size> <file>    Read <size> bytes from <addr> to <file>
  erase_flash                        Erase the entire flash
  erase_region <addr> <size>         Erase a flash region
  write_flash <addr> <file>...       Flash firmware at <addr> (addr/file pairs)
  run                                Leave the bootloader and run the app

Options:
  -p, --port H    Use an existing serial handle from 'serial request'
  -b, --baud N    Flash baud rate (default ${DEFAULT_BAUD})
  -c, --chip C    auto (default), or the chip to expect (esp32, esp32s3, ...)
  --vid 0x..      Picker filter when --port is omitted
  --pid 0x..      Picker filter when --port is omitted
  --before default_reset   --after hard_reset   (the only ones supported)
  -e, --erase     write_flash: erase the whole chip before writing
  --version
  -h, --help

Without --port, the Web Serial picker opens (asks for permission).
Every subcommand resets the chip and writes to it, so it needs root: sudo esptool ...
Subcommands take - or _ (write-flash, write_flash); chip_info and id are chip_id.
`;

export const CHIPS = [
  'esp8266',
  'esp32',
  'esp32s2',
  'esp32s3',
  'esp32s31',
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32c61',
  'esp32e22',
  'esp32h2',
  'esp32h21',
  'esp32h4',
  'esp32p4',
];

const VALUES = {
  '-p': '--port',
  '--port': '--port',
  '-b': '--baud',
  '--baud': '--baud',
  '-c': '--chip',
  '--chip': '--chip',
  '--vid': '--vid',
  '--pid': '--pid',
  '--before': '--before',
  '--after': '--after',
};
const BOOLS = {
  '-e': '--erase',
  '--erase': '--erase',
  '--erase-all': '--erase',
  '-z': '--compress',
  '--compress': '--compress',
};
const SIMPLE = ['chip_id', 'read_mac', 'flash_id', 'erase_flash', 'run'];
const SUBCOMMANDS = [...SIMPLE, 'read_reg', 'read_flash', 'erase_region', 'write_flash'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Usage extends Error {}

export class Failure extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function version(ctx) {
  const raw = await ctx.fs.readFile(`${ctx.env.SLICC_PACKAGE}/package.json`);
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  return JSON.parse(text).version;
}

function spelled(token) {
  if (!token.startsWith('--')) return token;
  return `--${token.slice(2).replaceAll('_', '-')}`;
}

export function parseArgs(args) {
  const positionals = [];
  const flags = new Map();
  const bools = new Set();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const at = token.indexOf('=');
    const name = spelled(at > 0 && token.startsWith('--') ? token.slice(0, at) : token);
    if (VALUES[name]) {
      if (at > 0 && token.startsWith('--')) flags.set(VALUES[name], token.slice(at + 1));
      else if (i + 1 >= args.length) throw new Usage(`${token}: needs a value`);
      else flags.set(VALUES[name], args[++i]);
    } else if (BOOLS[name] && at < 0) bools.add(BOOLS[name]);
    else throw new Usage(`unknown option ${token}`);
  }
  return { positionals, flags, bools };
}

export function canonicalSub(sub) {
  const s = sub.replaceAll('-', '_');
  if (s === 'chip_info' || s === 'id') return 'chip_id';
  return s;
}

export function integer(value, label) {
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  throw new Usage(`invalid ${label}: '${value}'`);
}

function bounded(value, label, least) {
  const n = integer(value, label);
  if (n < least || n >= 2 ** 32) throw new Usage(`invalid ${label}: '${value}'`);
  return n;
}

export function chipOf(flags) {
  if (!flags.has('--chip')) return undefined;
  const given = flags.get('--chip');
  const chip = given.toLowerCase().replace(/[-_]/g, '');
  if (chip === 'auto') return undefined;
  if (!CHIPS.includes(chip)) throw new Usage(`invalid --chip: '${given}'`);
  return chip;
}

export function resets(flags) {
  const before = flags.get('--before');
  if (before !== undefined && before.replaceAll('-', '_') !== 'default_reset')
    throw new Usage(`--before ${before} is not supported (only default_reset)`);
  const after = flags.get('--after');
  if (after !== undefined && after.replaceAll('-', '_') !== 'hard_reset')
    throw new Usage(`--after ${after} is not supported (only hard_reset)`);
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
    throw new Usage('--pid needs --vid');
  return Object.keys(filter).length ? [filter] : [];
}

export function header(positionals, flags, bools) {
  const sub = canonicalSub(positionals[0] ?? '');
  if (!SUBCOMMANDS.includes(sub)) throw new Usage(`unknown subcommand '${positionals[0] ?? ''}'`);
  if (bools.has('--erase') && sub !== 'write_flash')
    throw new Usage(`${sub}: --erase is for write_flash`);
  if (flags.has('--port') && (flags.has('--vid') || flags.has('--pid')))
    throw new Usage('--vid and --pid choose a port, so they take no --port');
  resets(flags);
  const out = { op: sub };
  if (flags.has('--baud')) out.baud = bounded(flags.get('--baud'), 'baud', 1);
  const chip = chipOf(flags);
  if (chip) out.chip = chip;
  return operands(sub, positionals.slice(1), out, bools);
}

function operands(sub, args, out, bools) {
  const expect = (count, shape) => {
    if (args.length !== count) throw new Usage(`${sub} expects ${shape}`);
  };
  if (SIMPLE.includes(sub) && args.length) throw new Usage(`${sub}: too many arguments`);
  if (sub === 'read_reg') {
    expect(1, '<addr>');
    out.address = bounded(args[0], 'address', 0);
  }
  if (sub === 'read_flash' || sub === 'erase_region') {
    expect(
      sub === 'read_flash' ? 3 : 2,
      sub === 'read_flash' ? '<addr> <size> <file>' : '<addr> <size>'
    );
    out.address = bounded(args[0], 'address', 0);
    out.size = bounded(args[1], 'size', 1);
  }
  if (sub === 'erase_region' && (out.address % SECTOR || out.size % SECTOR))
    throw new Failure('erase_region needs a 4 KiB aligned address and size', 'EINVAL');
  if (sub === 'write_flash') {
    if (!args.length || args.length % 2) throw new Usage('write_flash expects <addr> <file> pairs');
    out.erase = bools.has('--erase');
  }
  return out;
}

export function resolve(cwd, path) {
  const parts = [];
  for (const part of `${path.startsWith('/') ? '' : cwd}/${path}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

const hex = (n) => `0x${n.toString(16)}`;

export function checkSegments(segments) {
  let end = 0;
  let total = 0;
  for (const [i, segment] of segments.entries()) {
    if (!segment.size) throw new Failure(`${segment.file} is empty`, 'EINVAL');
    if (i > 0 && segment.address < end)
      throw new Failure(
        `write_flash segments overlap or are out of order: ${hex(segment.address)} starts before ${hex(end)}`,
        'EINVAL'
      );
    end = segment.address + segment.size;
    total += segment.size;
    if (total > FLASH_LIMIT) throw new Failure('write_flash takes at most 16 MiB', 'EINVAL');
  }
  return total;
}

async function firmware(ctx, args) {
  const segments = [];
  for (let i = 0; i < args.length; i += 2) {
    const address = bounded(args[i], 'address', 0);
    const file = resolve(ctx.cwd, args[i + 1]);
    const raw = await ctx.fs.readFile(file);
    const data = typeof raw === 'string' ? encoder.encode(raw) : new Uint8Array(raw);
    segments.push({ address, size: data.byteLength, file: args[i + 1], data });
  }
  const total = checkSegments(segments);
  const body = new Uint8Array(total);
  let at = 0;
  for (const segment of segments) {
    body.set(segment.data, at);
    at += segment.size;
  }
  return {
    segments: segments.map(({ address, size }) => ({ address, size })),
    body,
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

export async function ask(ctx, kind, options, body) {
  let file;
  const failed = (error) => new Failure(reason(error, kind), error?.code);
  try {
    file = await ctx.open('/dev/embedder', { read: true, write: true });
    await file.write(0, encoder.encode(`${JSON.stringify({ kind, ...options })}\n`));
    if (body?.length) await file.write(0, body);
    const parts = [];
    let size = 0;
    for (;;) {
      const chunk = await file.read(0, 65536);
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
  } catch (error) {
    throw failed(error);
  } finally {
    await Promise.allSettled([file?.close()]);
  }
}

function sudoHint(ctx, error) {
  if (error.code !== 'EACCES' || !/is not allowed for this user/.test(error.message)) return error;
  return new Failure(
    `${error.message} (esptool needs root: sudo esptool ${ctx.argv.slice(1).join(' ')})`,
    error.code
  );
}

async function dispatch(ctx, args) {
  const { positionals, flags, bools } = parseArgs(args);
  const options = header(positionals, flags, bools);
  const picker = flags.has('--port') ? null : filters(flags);
  let body;
  if (options.op === 'write_flash') {
    const loaded = await firmware(ctx, positionals.slice(1));
    options.segments = loaded.segments;
    body = loaded.body;
  }
  let handle = flags.get('--port');
  if (!handle) {
    const port = JSON.parse(decoder.decode(await ask(ctx, 'serial.request', { filters: picker })));
    handle = port.handle;
  }
  const reply = await ask(ctx, 'serial.esptool', { handle, ...options }, body).catch((error) => {
    throw sudoHint(ctx, error);
  });
  if (options.op !== 'read_flash') return ctx.write(1, reply);
  const out = resolve(ctx.cwd, positionals[3]);
  await ctx.fs.writeFile(out, reply);
  return ctx.write(1, `Wrote ${reply.byteLength} bytes to ${out}\n`);
}

export default async function esptool(ctx) {
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
    await dispatch(ctx, args);
    return 0;
  } catch (error) {
    if (error instanceof Usage) {
      await ctx.write(2, `esptool: ${error.message} (see esptool --help)\n`);
      return 2;
    }
    await ctx.write(2, `esptool: ${error.message}\n`);
    return 1;
  }
}
