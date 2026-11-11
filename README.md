# slicc-devices

Device access for SLICC through the browser's own device APIs: Web Serial first, then esptool, WebUSB, WebHID and Web Bluetooth LE. The kernel runs commands in a worker, which has none of these APIs, so a command asks seven's page over [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder), and this package's page module answers in the page.

```sh
serial request --vid 0x2e8a
serial open serial1 --baud 115200
serial read serial1 --until 0d0a
printf 'print(1)\r\n' | sudo serial write serial1
serial console serial1
sudo esptool --port serial1 write-flash 0x1000 bootloader.bin 0x10000 app.bin
```

## Install

slicc-bios bundles `@ai-ecoverse/slicc-devices/page` and registers it on its `/dev/embedder` hook through `plugged()`, as it does `@ai-ecoverse/slicc-capture/page`. The package declares `serial` and `esptool` in `slicc.commands`, so `pnpm add -g @ai-ecoverse/slicc-devices` puts them in `/usr/bin`. Its one dependency is [esptool-js](https://github.com/espressif/esptool-js) 0.7.1 (Apache-2.0, pinned exactly; it brings pako and atob-lite, which its bundle already contains), so seven installs it beside the package. It needs slicc-kernel 1.176.0 or later (`engines.slicc-kernel`), for `/dev/embedder` and for `session: false` in a kind's policy, which keeps writes root's; an older kernel refuses the command with exit 126.

## Commands

`serial` has slicc 6's syntax and output, plus `read --follow` and `console`. [`esptool`](#esptool) flashes ESP32 and ESP8266 chips over a serial port.

```
serial list                                   # serial1  0x2e8a:0x0005 [open]
serial request [--vid N] [--pid N]            # hex or decimal; prints the row
serial open <h> [--baud N] [--data-bits 7|8] [--stop-bits 1|2] [--parity none|even|odd] [--flow-control none|hardware] [--buffer-size N]
serial close <h>
serial read <h> [--bytes N] [--until HEX] [--timeout-ms N] [--hex] [--follow]
serial write <h>                              # stdin; prints "<n> bytes written"
serial signals <h> get                        # cts=1 dcd=0 dsr=1 ri=0
serial signals <h> set [--dtr on|off] [--rts on|off] [--break on|off]
serial console <h> [--baud N]                 # opens if closed; raw terminal; C-a C-x quits
```

- **`list`:** one row per port the page knows and the browser still has, in handle order: the handle, a tab, then `0x<vid>:0x<pid>` for a USB port, `(bluetooth <class id>)` for a Bluetooth one, or `(native serial)`, then ` [open]` when it is open. With none, `no granted serial ports`.
- **`request`:** asks the browser's chooser for a port, filtered by `--vid` and `--pid` (hex with `0x`, or decimal; `--pid` needs `--vid`), and prints the chosen port's row. A port granted before keeps its handle. See [A click is needed](#a-click-is-needed).
- **`open`:** `--baud` defaults to 9600, slicc 6's default. A port is opened once: a second `open` fails until `close`.
- **`close`:** closing a closed port succeeds.
- **`read`:** writes the bytes raw to stdout, or as one line of space-separated hex with `--hex`. It stops after `--bytes N`, once the `--until` bytes are seen (included; `0d0a`, `0x0d 0x0a` and `0d:0a` are all accepted), or after `--timeout-ms` (default 1000) without data; `--timeout-ms 0` waits without a limit. What it doesn't take stays buffered for the next read. `--follow` streams until the request ends, with no cap and no timeout, a hex line per chunk with `--hex`, and takes no `--bytes`, `--until` or `--timeout-ms`.
- **`write`:** sends stdin and prints `<n> bytes written` once the port has taken it.
- **`signals`:** `get` prints the input signals as `cts=1 dcd=0 dsr=1 ri=0`; `set` sets the output ones (`on`, `true`, `1`, `off`, `false`, `0`) and needs at least one.
- **`console`:** a raw terminal on the port, as picocom is. It opens the port when it is closed, at `--baud` (default 115200), and closes it again on the way out; a port that was open stays open, at its own settings. The device's output goes to the terminal as it comes, and every key goes to the device, `^C` included (it is a byte in raw mode, not a signal, so a REPL gets its interrupt). **C-a C-x** quits with 0, and **C-a C-a** sends one C-a. It is one `serial.read` with `follow`, plus a `serial.write` for typed keys, at most one in flight and the rest coalesced. When a write is refused with `EACCES` it prints `serial: writes need root: sudo serial console <h>` once, drops what is typed and goes on reading. When the port closes it says `serial: <h> was closed` and exits 0; when the port goes away it says why and exits 1. It needs a terminal on stdin.
- **^C:** a `SIGINT` during `read`, `read --follow` or `console` ends the request and exits 130, with no error line.
- **Progress:** the page's progress lines reach stderr as `serial: <line>`, such as `serial: waiting for a click in seven's tab: choose a serial port` and `serial: serial1: 512 bytes dropped (nobody read in time)`.
- **Limits:** a read without `--follow` or a write over 4 MiB fails: `serial: read --bytes exceeds 4 MiB limit` and `serial: write payload exceeds 4 MiB limit`, before anything is asked.
- **Exit codes:** 0 on success; 1 on an error, as `serial: <message>` (the page's message, see [Errors](#errors)); 2 on a usage error, as `serial: <what> (see serial --help)`. With no arguments, `--help` or `-h`, it prints the help and exits 0. `--version` alone prints the package version and exits 0; with any other arguments it is a usage error (`--help` and `-h` still print the help, as with `sccapture`).
- **Writes need root:** `serial.write` and `serial.control` are root's, so for anyone else they fail with `serial: serial.write is not allowed for this user (writes need root: sudo serial write serial1)`. A user outside `dialout` gets the same for every subcommand (`serial: serial.list is not allowed for this user`).
- **Outside SLICC** (no page answers): `serial: needs seven's page (no page answers serial.list)`, exit 1.
- **Why a JS program:** `serial` is one self-contained ES module (`bin/serial.mjs`, `abi: "js"`). `console` needs a raw terminal and a read that runs while writes go out, and `read --hex` and the argument checks are far simpler in JS than in `sh`; a JS program opens `/dev/embedder` with `ctx.open`, and one request per open description runs alongside the others.

## Permissions

- **The only prompt is the browser's own:** the device chooser, plus one item in seven's tab when the chooser needs a click that isn't there. No per-agent, per-session or per-operation prompt, and none extra for flashing, erasing or the like. Nothing skips the chooser, neither an extension nor CDP.
- **Kernel permissions do the rest:** each kind carries a policy in `kinds`, which the kernel checks before the page sees the request. Reading is for members of the device's group: `dialout` for serial, `plugdev` for USB and HID, `bluetooth` for Bluetooth LE. Writing needs root, which for an agent means `sudo`, judged as for any command. The owner and every agent are in these groups by default, and the person's own terminal is root.
- **Grants:** only the browser's own (`getPorts()` and the like); this package lists or forgets nothing beyond them. Enterprise-policy pre-grants are used as they come; seven never sets such policy.
- **The off switch:** each kind of device has a switch in seven's settings, beside Camera, Microphone and Screen. Turning it off refuses that kind's requests, closes its open ports, and cancels opens and chooser requests that were still in flight (they fail with the same `EACCES` as a request made while the switch is already off). A chooser grant that arrives after the switch is off is not registered then; the browser's grant still stands, so once the switch is on again the next `getPorts()` sync lists that port closed.
- **No device data in errors:** errors, progress lines and logs never carry the bytes read from or written to a device.

## Browsers

| browser | |
| --- | --- |
| Chrome, Edge, Opera on a desktop | Web Serial, WebUSB, WebHID and Web Bluetooth |
| Firefox, Safari, any browser on iOS | none of them: every kind answers `ENOTSUP` |

## The page module

`@ai-ecoverse/slicc-devices/page` is plain ES modules with no build step, which run in Chrome and load in Node: `page/index.mjs`, which imports nothing up front, and `page/esptool.mjs`, which it imports (`import('./esptool.mjs')`) only when a `serial.esptool` request comes. That one imports esptool-js's self-contained `esptool-js/bundle.js` (no imports of its own, no `eval`, nothing fetched), from the installed package, so seven's boot doesn't grow and nothing loads from a CDN: seven's service worker resolves the bare specifier to `node_modules/esptool-js/bundle.js`.

```js
import { create } from '@ai-ecoverse/slicc-devices/page';

const serial = create({ enabled: () => settings.serial !== false });
const kinds = { ...serial.kinds };
const handlers = { ...plugged(serial, serial.prompts) };
serial.ports.watch(indicator);
```

- **The exports:** `kinds`, the kinds it answers with their policies; `prompts`, bios's `plugged()` prompts, for `serial.request` only; `ports`, for seven's indicator and off switch; `handle(request)`, a [`/dev/embedder` hook](https://github.com/ai-ecoverse/slicc-kernel#devembedder)'s `handle`, which gets the kernel's `{ kind, options, body, stamp, signal, progress }`; `create(overrides)`, which returns another `{ kinds, prompts, ports, handle }` with its own handles and ports; and the default export, the same four. `create` takes `enabled`, a function the page asks before a request and again after each await that could race the off switch (on by default), `navigator`, which replaces the page's own, and `esptool`, a function that loads `page/esptool.mjs` (both for tests).
- **`prompts['serial.request'](request)`:** answers `null` when the request was typed in a terminal while the user is active (bios's `typed && active` rule: every tag of the stamp is `{ kind: 'user', where: 'terminal:…' }`, and `navigator.userActivation.isActive`), so bios calls `handle` at once, inside the keystroke's activation. Otherwise it first sends `progress("waiting for a click in seven's tab: choose a serial port")`, then answers the prompt bios shows: `{ title: 'Choose a serial port', body: '<asker> wants to use a serial port. Click Choose, then pick it in the browser\'s list.', action: 'Choose…', cancel: 'Cancel', variant: 'confirmation', dismissed: 'no serial port was chosen', late: 'nobody clicked within 5 min' }`, where the asker is `The agent <id>` for an agent's tag and `A program` otherwise. It answers `null` when the switch is off or there is no Web Serial, so `handle` refuses at once. No other kind prompts.
- **`ports`:** `list()` gives the ports `serial.list` would, and `open()` the open ones, as `{ handle, usbVendorId?, usbProductId?, bluetoothServiceClassId?, open }`. `close(handle)` closes one in seven (an unknown or closed handle does nothing), and `closeAll()` every open one and any open or request still in flight (they then fail with `EACCES` / `serial ports are off in seven's settings`, without forgetting the browser's grant), which is what turning the switch off does. `watch(listener)` calls `listener` with `{ type: 'open', handle, info, stamp, since }` when a port opens (`stamp` names the asker, `since` is `Date.now()`) and `{ type: 'close', handle, why }` when it closes, however it closes (`why` is `closed` for `serial.close`, `seven` for `ports.close` and `closeAll`, `unplugged` when it went away), and returns a function that stops it. bios adds the live item on `open`, with `Close` running `ports.close(handle)`, and removes it on `close`.
- **A kind it doesn't know:** `handle` rejects with a `NotSupportedError` `slicc-devices does not answer <kind>`, which the kernel turns into `ENOTSUP`. A kind the hook doesn't list never reaches it: the kernel answers `ENOTSUP` itself.

## Serial

### Kinds

Every request but `serial.list` and `serial.request` names its port with `handle` (`serial<N>`). A "JSON" reply is one UTF-8 JSON value with no trailing newline.

| kind | policy (`kinds`) | header | body | reply |
| --- | --- | --- | --- | --- |
| `serial.list` | `{ group: 'dialout', session: false }` | — | — | JSON `[{ handle, usbVendorId?, usbProductId?, bluetoothServiceClassId?, open }]`, in handle order |
| `serial.request` | the same | `filters`: `[{ usbVendorId?, usbProductId?, bluetoothServiceClassId? }]` (may be empty; `usbProductId` needs `usbVendorId`) | — | JSON of the chosen port, as one `list` entry |
| `serial.open` | the same | `handle`, `baudRate` (required, a positive integer), `dataBits` (7, 8), `stopBits` (1, 2), `parity` (`none`, `even`, `odd`), `flowControl` (`none`, `hardware`), `bufferSize` | — | empty |
| `serial.read` | the same | `handle`, `bytes` (stop after N), `until` (hex; stop once seen, included), `timeout` (ms without data before the end; default 1000; `0` is none), `follow: true` (no cap and no timeout, and none of the three: stream until the request ends) | — | a byte stream |
| `serial.signals` | the same | `handle` | — | JSON `{ clearToSend, dataCarrierDetect, dataSetReady, ringIndicator }` |
| `serial.close` | the same | `handle` | — | empty; closing a closed port succeeds |
| `serial.write` | `{ session: false }` (root only) | `handle` | the bytes | the count written, in decimal |
| `serial.control` | `{ session: false }` | `handle`, `dataTerminalReady?`, `requestToSend?`, `break?` (booleans, at least one) | — | empty |
| `serial.esptool` | `{ session: false }` | `handle`, `op`, `baud` (default 115200), `chip?`, and the op's arguments (see [esptool](#esptool)) | `write_flash`: the segments' bytes, in order | text lines; `read_flash`: the bytes, streamed |

`session: false` drops the session's own user (the user a terminal or a connection runs as, such as a cone) from the kernel's allow-list, so `serial.write`, `serial.control` and `serial.esptool` are root's alone (for an agent, `sudo`), and the other kinds are for root and the members of `dialout` (gid 20).

### Handles

- `serial1`, `serial2`, … are numbered in the order the page first sees a port: from `getPorts()` at the first request, then the ports the chooser grants and the ones that connect.
- A handle stays the same for the page's lifetime. It lives in the tab whose page answers: another seven tab has its own numbering, and opening a port that tab holds open fails.
- **Re-enumeration:** when a granted port disconnects and a port with the same `usbVendorId:usbProductId` comes back through the browser's `connect` event or `getPorts()` (an esptool reset), it takes the old handle back, closed. It does so only when exactly one gone handle has those ids; with two or more it gets a new handle, as does a port picked in the chooser (`serial.request`), so a second board with the same ids never takes over another board's handle.
- **Unplugged:** a port that is open when it vanishes closes, and its reads end with `EIO` (`serial1 was unplugged`), as does any request for its handle until it comes back.

### Reading

- From `open`, the page reads the port continuously into a 1 MiB buffer, so data isn't lost between `read` requests.
- When the buffer is full, the oldest bytes are dropped, and the page says how many with `progress('serial1: <n> bytes dropped (nobody read in time)')`: at once while a read is attached (a `follow` read or `console` included; further drops are added up and reported at most every 250 ms), else when the next `read` starts.
- A `read` takes from that buffer, then from the port, as the program reads its reply: the page's stream has no queue of its own, so `/dev/embedder` paces it by the program. Only one `read` at a time per handle; a second one fails (`another read is in progress on serial1`). What a read doesn't take stays in the buffer.
- A `read` ends at end of file when the port closes, and with an error when it is unplugged. Ending the request (`^C`, closing the description) ends the read and leaves the rest buffered.

### Writing

The page takes the whole body first, at most 4 MiB, so a write over the limit fails with nothing passed to the port. Then it hands the bytes to the port's writer through `writer.ready`, as fast as the port takes them, and the kernel's 1 MiB window holds a fast writer back meanwhile. The reply comes after the port has taken the last byte. Writes to one port run one after another.

### Limits

A read without `follow` (`bytes` over 4 MiB, or 4 MiB without `bytes`) or a write over 4 MiB fails with a `QuotaExceededError` (`EIO`).

### Errors

The page throws a `DOMException` (or a `TypeError` for a bad header), and the kernel maps it.

| case | name | errno | message |
| --- | --- | --- | --- |
| unknown handle | `NotFoundError` | `ENOENT` | `unknown serial handle 'serial9'` |
| the chooser was cancelled, or the prompt dismissed | `NotAllowedError` | `EACCES` | `no serial port was chosen` |
| nobody clicked | `NotAllowedError` | `EACCES` | `nobody clicked within 5 min` |
| the chooser was called without a user activation | `NotAllowedError` | `EACCES` | `choosing a serial port needs a click in seven's tab` |
| Web Serial is missing | `NotSupportedError` | `ENOTSUP` | `this browser has no Web Serial (use Chrome, Edge or Opera on a desktop)` |
| not open | `InvalidStateError` | `EIO` | `serial1 is not open (serial open serial1 --baud N)` |
| open already | `InvalidStateError` | `EIO` | `serial1 is already open` |
| busy elsewhere | `InvalidStateError` | `EIO` | `serial1 is open in another tab or program` |
| a second read | `InvalidStateError` | `EIO` | `another read is in progress on serial1` |
| closed in seven | `InvalidStateError` | `EIO` | `serial1 was closed in seven` |
| unplugged | `InvalidStateError` | `EIO` | `serial1 was unplugged` |
| over 4 MiB | `QuotaExceededError` | `EIO` | `a serial read is at most 4 MiB without follow`, `a serial write is at most 4 MiB` |
| a bad header | `TypeError` | `EIO` | `invalid baudRate: 0`, `invalid until: "abc"`, `follow takes no bytes, until or timeout`, … |
| turned off | `NotAllowedError` | `EACCES` | `serial ports are off in seven's settings` |

### A click is needed

`navigator.serial.requestPort` needs a user activation.
- **Typed in a terminal while the user is active:** `prompts` answers `null`, and the page calls `requestPort` at once, inside the keystroke's activation.
- **Otherwise** (an agent, a script, a stale activation): the page sends `progress("waiting for a click in seven's tab: choose a serial port")`, and bios shows the prompt `prompts` answers, whose **Choose…** button is the user activation; `handle` then calls `requestPort` inside that click. Cancel gives `no serial port was chosen`; no click within 5 minutes gives `nobody clicked within 5 min` (`EACCES`, bios's `late`).

## esptool

```
esptool [-p H] [-b N] [-c CHIP] <subcommand> [args]
esptool chip_id                               # Chip type, description, features, crystal, MAC
esptool read_mac                              # MAC: 24:0a:c4:12:34:56
esptool flash_id                              # Manufacturer, Device, Detected flash size
esptool read_reg <addr>                       # 0x3ff5a004 = 0xc4123456
esptool read_flash <addr> <size> <file>       # Wrote <n> bytes to <file>
esptool erase_flash                           # flash erased
esptool erase_region <addr> <size>            # region erased (4 KiB aligned)
esptool write_flash [-e] <addr> <file>...     # flash written
esptool run                                   # running app
```

slicc 6's `esptool`, on esptool-js, with its subcommands, flags and output, plus Python esptool's spellings:

- **Spellings:** `-` and `_` are the same in subcommands and long flags (`write-flash`, `write_flash`, `--erase-all`, `--erase_all`), `chip_info` and `id` are `chip_id`, and `--flag=value` works. `-p`/`--port` takes a handle (`serial1`), `-b`/`--baud` the baud rate after the stub is running (default 115200), `-c`/`--chip` `auto` (the default) or a chip (`esp32`, `esp32s3`, `ESP32-C3`, …): a chip that isn't the one found fails before anything else runs, with `esptool: this chip is ESP8266, not esp32 (wrong --chip?)`. `--before default_reset` and `--after hard_reset` (or `default-reset`, `hard-reset`) are accepted; any other value is refused by name. `-e`, `--erase` and `--erase-all` make `write_flash` erase the whole chip first; `-z` and `--compress` are accepted (it always compresses). Numbers are hex with `0x` or decimal.
- **Without `--port`:** it runs `serial request` first, filtered by `--vid` and `--pid`, so the [click](#a-click-is-needed) applies, and uses the chosen port.
- **Past the end:** once the chip is connected, `write_flash`, `read_flash` and `erase_region` are refused when they reach past the flash size the flash id tells, before anything is erased or written: `esptool: 0x3ff000+0x2000 is past the end of the 4MB flash`, exit 1.
- **Firmware:** `write_flash` reads its files from the kernel's file system, relative to the working directory, and sends them as the request's body. Segments must be in address order, must not overlap and are at most 16 MiB together, and `erase_region` needs a 4 KiB aligned address and size; the command checks these and fails with exit 1 before it asks the page (`esptool: write_flash segments overlap or are out of order: 0x2000 starts before 0x3000`, `esptool: write_flash takes at most 16 MiB`, `esptool: erase_region needs a 4 KiB aligned address and size`), and the page checks them again. `read_flash` writes what it reads to `<file>` and prints `Wrote <n> bytes to <absolute path>`.
- **Output:** stdout gets slicc 6's lines, as above. esptool-js's own lines (`Connecting...`, `Chip is …`, `Uploading stub...`, `Writing at 0x10000... (40%)`, `Hard resetting via RTS pin...`) are progress: they reach stderr as `esptool: <line>`, at most one every 250 ms (the kernel passes 4 a second). Lines that come faster are coalesced: only the latest waits, with the last percentage line before it, and the rest are dropped. When the op is done, at most the one latest line is still sent, so the reply comes right after the chip is done and not after a backlog.
- **Needs root:** every subcommand resets the chip and writes to it, so `serial.esptool` is root's (`{ session: false }`): an agent runs `sudo esptool …`, which sudo's judge decides as for any command; anyone else gets `esptool: serial.esptool is not allowed for this user (esptool needs root: sudo esptool -p serial1 read_mac)`. There is no extra prompt for flashing.
- **Exit codes:** 0, 1 (`esptool: <message>`) or 2 (`esptool: <what> (see esptool --help)`), as for `serial`; `--help`, `-h` and `--version` too. A `^C` ends the request and exits 130, with no error line. Outside SLICC: `esptool: needs seven's page (no page answers serial.esptool)` (or `serial.request` without `--port`).

### On the page

- **The request:** `serial.esptool` takes `handle`, `op` (`chip_id`, `read_mac`, `flash_id`, `read_reg`, `read_flash`, `erase_flash`, `erase_region`, `write_flash`, `run`), `baud`, `chip` (lowercase, without `-`; the check happens right after the chip is detected) and the op's arguments: `address` for `read_reg`; `address` and `size` for `read_flash` and `erase_region`; `segments: [{ address, size }]` and `erase` for `write_flash`, whose body is the segments' bytes in order and must be exactly as long.
- **The port:** the handle's `SerialPort`. A port `serial` holds open is taken over: its reader and writer are released and esptool-js opens it at 115200. While esptool runs, the port is open (`ports` and the live item show it, with the asker that opened it) and every other `serial.*` request for it but `serial.close` fails with `serial1 is in use by esptool`, a second `serial.esptool` too. It connects with a reset into the bootloader, uploads the stub and runs the op; then it hard-resets the chip and closes the port (`close` with `why: 'closed'`). A board that re-enumerates on that reset keeps its handle, as [Handles](#handles) says.
- **Aborts:** `serial.close`, Close in seven (`ports.close`), the Serial ports switch (`closeAll`) and an unplug abort a running request, and so does the end of the request (`^C`). The request claims the handle before anything else, so this holds from the start: a Close while esptool-js is still loading or the firmware body is still arriving fails the request with `serial1 was closed in seven` (`serial1 was closed` for `serial.close`), and nothing reaches the chip and the port is never opened; a port `serial` held open is closed as any Close closes it. An abort skips the hard reset, so a chip that was reached stays in its bootloader, and the error says so: `serial1 was closed in seven; the chip stays in its bootloader (press RESET, or esptool --port serial1 run)`.
- **Errors** (all `EIO` but the ones [Errors](#errors) lists): a chip that never answers gives `no ESP chip answered on serial1 (hold BOOT and press RESET, then try again)`; a chip mismatch, `this chip is ESP8266, not esp32 (wrong --chip?)`; a `write_flash` segment, `read_flash` or `erase_region` whose end is past the flash size read from the flash id, `0x3ff000+0x2000 is past the end of the 4MB flash`, before anything is erased, written or read (a flash whose size the id doesn't tell is not checked); a port another tab holds, `serial1 is open in another tab or program`; a bad header or body is a `TypeError` (`invalid op: "reboot"`, the segment and alignment messages above, `the body has 3 bytes; the segments need 4`). Other esptool-js failures pass their first line, without the bytes it read.
- **Why `EIO` and not `EINVAL`:** the kernel turns a page's `TypeError` into `EIO` (only `NotAllowedError`, `AbortError`, `NotSupportedError` and `NotFoundError` have errnos of their own), so the `EINVAL` checks live in the command, before anything reaches the page or the chip.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks.
- `npm test`: the integration tests in `test/integration/`. No test touches a real serial, USB, HID or Bluetooth device: `fake-devices.mjs` has a fake `navigator.serial` (`FakeSerial`, with `getPorts()`, a scripted chooser, `plug()` and `unplug()`) and fake ports (`FakeSerialPort`, with `ReadableStream`/`WritableStream`, `feed()`, an echo or a slow sink, and signals), and wraps the page module in a test `/dev/embedder` hook (`embedder(page, kinds, { gesture })`) that runs its `prompts` as bios's `plugged()` does, with a stubbed gesture; `request()` makes a kernel-shaped request and `errno()` the kernel's mapping of an error.
  - `scenarios.mjs` holds the page module's rows (list, request, open, read with bytes, until and timeouts, follow, writes and their pacing, the 4 MiB limits (a 3 + 2 MiB write leaves nothing on the device), the buffer overflow before a read and during a follow read, signals, close, unplug and re-enumeration, a second identical board in the chooser, and console's read and writes together), each with its expected result. `page.test.mjs` runs them in Node, and `browser.test.mjs` runs the same rows in Chrome.
  - `fake-esp.mjs` is a fake ESP ROM loader behind a `FakeSerialPort` (`device`): SLIP framing, SYNC, register reads and writes (the chip magic, eFuses for the MAC and description, the SPI registers that answer the flash id), the stub upload (MEM_BEGIN, MEM_DATA, MEM_END and `OHAI`), FLASH_DEFL_BEGIN, DATA and END over an in-memory flash, READ_FLASH, ERASE_FLASH and ERASE_REGION, as an ESP32 or an ESP8266, or silent. `esptool-scenarios.mjs` holds the esptool rows (chip_id with its progress lines and their pace, read_mac, flash_id and read_reg, two segments written and read back, erase_region, erase_flash clearing what the flash held, write_flash with erase clearing all but the new image, run resetting the chip into its app, a `--chip` mismatch, a silent chip, Close and the switch mid-write, Close while esptool-js loads (also on a port `serial` holds open) and while the body still arrives, writes, reads and erases past the end of the flash, the limits, and a port `serial` held open), which `page.test.mjs` runs in Node and `browser.test.mjs` in Chrome, on the real esptool-js. `esptool.test.mjs` runs the `esptool` command on the Node kernel: help, version, usage errors, Python spellings, the command's own checks, files flashed and read back, erase_flash, write_flash `--erase-all` and run, root only with `sudo`, the request path without `--port`, a mismatch, `^C` and outside SLICC.
  - `page.test.mjs` also runs requests through `/dev/embedder`, and `command.test.mjs` runs `serial` on `@ai-ecoverse/slicc-kernel/node` (pinned exactly) with wasm-bash and wasm-coreutils (`kernel.mjs`): every subcommand and output format, the usage errors, ^C, `console` on a terminal, outside SLICC, and the permission rows (a `dialout` member reads but can't write, `sudo serial write` works, a user outside `dialout` gets nothing, and the same member, the session's user there, writes when the write kinds lack `session: false`).
  - `browser.test.mjs` drives Chrome through slicc-shared-web's harness, over a CDP pipe and no TCP port; it runs on CI only, and is skipped without `CI`. Besides the rows, it runs `serial` end to end in the browser kernel (the command, the `/dev/embedder` relay, the page module and the fake), with a real keystroke's activation for `serial request`, and `esptool read-mac` the same way, with esptool-js loaded through an import map from `node_modules/esptool-js`.
  - `repo.test.mjs` checks the workflow, the release config, the pinned devDependencies, the exports, the `serial` and `esptool` commands, the esptool-js pin, its license and its lazily loaded, self-contained bundle, and what `npm pack` ships.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, then on a pull request the reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`.

## License

Apache-2.0
