const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;
const MAGIC_REG = 0x40001000;
const SPI_CMD_USR = 1 << 18;
const RDID = 0x9f;

export const OP = {
  flashBegin: 0x02,
  flashData: 0x03,
  flashEnd: 0x04,
  memBegin: 0x05,
  memEnd: 0x06,
  memData: 0x07,
  sync: 0x08,
  writeReg: 0x09,
  readReg: 0x0a,
  spiAttach: 0x0d,
  changeBaud: 0x0f,
  deflBegin: 0x10,
  deflData: 0x11,
  deflEnd: 0x12,
  securityInfo: 0x14,
  eraseFlash: 0xd0,
  eraseRegion: 0xd1,
  readFlash: 0xd2,
};

const STUB_ONLY = [OP.eraseFlash, OP.eraseRegion, OP.readFlash];

export const CHIPS = {
  ESP32: {
    magic: 0x00f01d83,
    spi: 0x3ff42000,
    usr2: 0x24,
    w0: 0x80,
    registers: (mac) => ({
      [0x3ff5a000 + 4]: ((mac[2] << 24) | (mac[3] << 16) | (mac[4] << 8) | mac[5]) >>> 0,
      [0x3ff5a000 + 8]: (mac[0] << 8) | mac[1],
      [0x3ff5a000 + 12]: 1 << 15,
      [0x3ff5a000 + 20]: 1 << 20,
      [0x3ff6607c]: 0x80000000,
      [0x3ff40014]: 347,
    }),
  },
  ESP8266: {
    magic: 0xfff0c101,
    spi: 0x60000200,
    usr2: 0x24,
    w0: 0x40,
    registers: () => ({}),
  },
};

const u32 = (bytes, at) =>
  (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export function slip(bytes) {
  const out = [END];
  for (const byte of bytes) {
    if (byte === END) out.push(ESC, ESC_END);
    else if (byte === ESC) out.push(ESC, ESC_ESC);
    else out.push(byte);
  }
  out.push(END);
  return Uint8Array.from(out);
}

async function inflate(chunks) {
  const stream = new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class FakeEsp {
  constructor({
    chip = 'ESP32',
    mac = [0x24, 0x0a, 0xc4, 0x12, 0x34, 0x56],
    flashId = 0x164020,
    flashSize = 4 * 1024 * 1024,
    silent = false,
  } = {}) {
    this.chip = CHIPS[chip];
    this.name = chip;
    this.flashId = flashId;
    this.flash = new Uint8Array(flashSize).fill(0xff);
    this.silent = silent;
    this.registers = new Map(Object.entries(this.chip.registers(mac)).map(([k, v]) => [+k, v]));
    this.mode = 'rom';
    this.port = null;
    this.packet = null;
    this.escaped = false;
    this.queue = Promise.resolve();
    this.seen = [];
    this.pause = null;
    this.defl = null;
    this.plain = null;
    this.resets = 0;
    this.quiet = 0;
    this.booted = 0;
  }

  attach(port) {
    this.port = port;
    return this;
  }

  signal(signals) {
    this.quiet = Date.now();
    if (signals.requestToSend === true) {
      this.mode = 'rom';
      this.resets += 1;
    } else if (signals.requestToSend === false && this.mode === 'stub') {
      this.mode = 'app';
      this.booted += 1;
    }
  }

  receive(bytes) {
    for (const byte of bytes) {
      if (this.packet === null) {
        if (byte === END) this.packet = [];
        continue;
      }
      if (this.escaped) {
        this.escaped = false;
        this.packet.push(byte === ESC_END ? END : byte === ESC_ESC ? ESC : byte);
      } else if (byte === ESC) this.escaped = true;
      else if (byte === END) {
        if (this.packet.length) {
          const done = Uint8Array.from(this.packet);
          this.queue = this.queue.then(() => this.handle(done)).catch(() => {});
          this.packet = null;
        }
      } else this.packet.push(byte);
    }
  }

  send(bytes) {
    this.port?.feed(slip(bytes));
  }

  reply(op, value = 0, data = [], status = 0) {
    const tail = this.mode === 'rom' ? [status, 0, 0, 0] : [status, 0];
    const body = [...data, ...tail];
    this.send([1, op, body.length & 0xff, body.length >> 8, ...le(value), ...body]);
  }

  unsupported() {
    const tail = this.mode === 'rom' ? [1, 5, 0, 0] : [1, 5];
    this.send([1, 0, tail.length, 0, 0, 0, 0, 0, ...tail]);
  }

  read(address) {
    if (address === MAGIC_REG) return this.chip.magic;
    return this.registers.get(address) ?? 0;
  }

  write(address, value, mask) {
    const old = this.registers.get(address) ?? 0;
    this.registers.set(address, ((old & ~mask) | (value & mask)) >>> 0);
    const { spi, usr2, w0 } = this.chip;
    if (address !== spi || !(value & SPI_CMD_USR)) return;
    if (((this.registers.get(spi + usr2) ?? 0) & 0xff) === RDID)
      this.registers.set(spi + w0, this.flashId);
    this.registers.set(spi, 0);
  }

  erase(address, size) {
    this.flash.fill(0xff, address, Math.min(this.flash.length, address + size));
  }

  async handle(packet) {
    if (this.silent || packet.length < 8 || packet[0] !== 0) return;
    this.quiet = Date.now();
    const op = packet[1];
    const length = packet[2] | (packet[3] << 8);
    const data = packet.subarray(8, 8 + length);
    this.seen.push(op);
    const held = this.pause?.(op, this);
    if (held) await held;
    if (this.mode === 'rom' && STUB_ONLY.includes(op)) return this.unsupported();
    if (op === OP.sync) {
      const value = this.mode === 'rom' ? 0x20120707 : 0;
      const count = this.mode === 'rom' ? 8 : 1;
      for (let i = 0; i < count; i++) this.reply(op, value);
      return;
    }
    if (op === OP.readReg) return this.reply(op, this.read(u32(data, 0)));
    if (op === OP.writeReg) {
      for (let at = 0; at + 16 <= data.length; at += 16)
        this.write(u32(data, at), u32(data, at + 4), u32(data, at + 8));
      return this.reply(op);
    }
    if (op === OP.memBegin || op === OP.memData || op === OP.spiAttach || op === OP.changeBaud)
      return this.reply(op);
    if (op === OP.memEnd) {
      this.reply(op);
      this.mode = 'stub';
      this.send([...'OHAI'].map((c) => c.charCodeAt(0)));
      return;
    }
    if (op === OP.flashBegin) {
      this.plain = { address: u32(data, 12), block: u32(data, 8) };
      this.erase(this.plain.address, u32(data, 0));
      return this.reply(op);
    }
    if (op === OP.flashData) {
      const seq = u32(data, 4);
      this.flash.set(data.subarray(16), this.plain.address + seq * this.plain.block);
      return this.reply(op);
    }
    if (op === OP.flashEnd) return this.reply(op);
    if (op === OP.deflBegin) {
      this.defl = { address: u32(data, 12), size: u32(data, 0), chunks: [] };
      this.erase(this.defl.address, this.defl.size);
      return this.reply(op);
    }
    if (op === OP.deflData) {
      this.defl.chunks.push(data.slice(16));
      return this.reply(op);
    }
    if (op === OP.deflEnd) {
      const image = await inflate(this.defl.chunks);
      this.flash.set(image, this.defl.address);
      this.defl = null;
      return this.reply(op);
    }
    if (op === OP.eraseFlash) {
      this.flash.fill(0xff);
      return this.reply(op);
    }
    if (op === OP.eraseRegion) {
      this.erase(u32(data, 0), u32(data, 4));
      return this.reply(op);
    }
    if (op === OP.readFlash) {
      const address = u32(data, 0);
      const size = u32(data, 4);
      const sector = u32(data, 8);
      this.reply(op);
      for (let at = 0; at < size; at += sector)
        this.send(this.flash.subarray(address + at, address + Math.min(size, at + sector)));
      this.send(new Uint8Array(16));
      return;
    }
    return this.unsupported();
  }
}
