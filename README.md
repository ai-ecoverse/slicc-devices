# slicc-devices

Device access for SLICC through the browser's own device APIs: Web Serial first, then esptool, WebUSB, WebHID and Web Bluetooth LE. The kernel runs commands in a worker, which has none of these APIs, so a command asks seven's page over [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder), and this package's page module answers in the page.

```sh
serial request --vid 0x2e8a
serial open serial1 --baud 115200
serial read serial1 --until 0d0a
printf 'print(1)\r\n' | sudo serial write serial1
serial console serial1
```

## Install

slicc-bios bundles `@ai-ecoverse/slicc-devices/page` and registers it on its `/dev/embedder` hook through `plugged()`, as it does `@ai-ecoverse/slicc-capture/page`. The package declares `serial` in `slicc.commands`, so `pnpm add -g @ai-ecoverse/slicc-devices` puts it in `/usr/bin`. It needs slicc-kernel 1.176.0 or later (`engines.slicc-kernel`), for `/dev/embedder` and for `session: false` in a kind's policy, which keeps writes root's; an older kernel refuses the command with exit 126.

## Commands

`serial` is the only command so far, with slicc 6's syntax and output, plus `read --follow` and `console`.

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
- **Exit codes:** 0 on success; 1 on an error, as `serial: <message>` (the page's message, see [Errors](#errors)); 2 on a usage error, as `serial: <what> (see serial --help)`. With no arguments, `--help` or `-h`, it prints the help and exits 0.
- **Writes need root:** `serial.write` and `serial.control` are root's, so for anyone else they fail with `serial: serial.write is not allowed for this user (writes need root: sudo serial write serial1)`. A user outside `dialout` gets the same for every subcommand (`serial: serial.list is not allowed for this user`).
- **Outside SLICC** (no page answers): `serial: needs seven's page (no page answers serial.list)`, exit 1.
- **Why a JS program:** `serial` is one self-contained ES module (`bin/serial.mjs`, `abi: "js"`). `console` needs a raw terminal and a read that runs while writes go out, and `read --hex` and the argument checks are far simpler in JS than in `sh`; a JS program opens `/dev/embedder` with `ctx.open`, and one request per open description runs alongside the others.

## Permissions

- **The only prompt is the browser's own:** the device chooser, plus one item in seven's tab when the chooser needs a click that isn't there. No per-agent, per-session or per-operation prompt, and none extra for flashing, erasing or the like. Nothing skips the chooser, neither an extension nor CDP.
- **Kernel permissions do the rest:** each kind carries a policy in `kinds`, which the kernel checks before the page sees the request. Reading is for members of the device's group: `dialout` for serial, `plugdev` for USB and HID, `bluetooth` for Bluetooth LE. Writing needs root, which for an agent means `sudo`, judged as for any command. The owner and every agent are in these groups by default, and the person's own terminal is root.
- **Grants:** only the browser's own (`getPorts()` and the like); this package lists or forgets nothing beyond them. Enterprise-policy pre-grants are used as they come; seven never sets such policy.
- **The off switch:** each kind of device has a switch in seven's settings, beside Camera, Microphone and Screen. Turning it off refuses that kind's requests and closes its open ports.
- **No device data in errors:** errors, progress lines and logs never carry the bytes read from or written to a device.

## Browsers

| browser | |
| --- | --- |
| Chrome, Edge, Opera on a desktop | Web Serial, WebUSB, WebHID and Web Bluetooth |
| Firefox, Safari, any browser on iOS | none of them: every kind answers `ENOTSUP` |

## The page module

`@ai-ecoverse/slicc-devices/page` is one plain ES module (`page/index.mjs`), with no build step and no dependencies, which runs in Chrome and loads in Node.

```js
import { create } from '@ai-ecoverse/slicc-devices/page';

const serial = create({ enabled: () => settings.serial !== false });
const kinds = { ...serial.kinds };
const handlers = { ...plugged(serial, serial.prompts) };
serial.ports.watch(indicator);
```

- **The exports:** `kinds`, the kinds it answers with their policies; `prompts`, bios's `plugged()` prompts, for `serial.request` only; `ports`, for seven's indicator and off switch; `handle(request)`, a [`/dev/embedder` hook](https://github.com/ai-ecoverse/slicc-kernel#devembedder)'s `handle`, which gets the kernel's `{ kind, options, body, stamp, signal, progress }`; `create(overrides)`, which returns another `{ kinds, prompts, ports, handle }` with its own handles and ports; and the default export, the same four. `create` takes `enabled`, a function the page asks before every request (the off switch; on by default), and `navigator`, which replaces the page's own (tests use it).
- **`prompts['serial.request'](request)`:** answers `null` when the request was typed in a terminal while the user is active (bios's `typed && active` rule: every tag of the stamp is `{ kind: 'user', where: 'terminal:…' }`, and `navigator.userActivation.isActive`), so bios calls `handle` at once, inside the keystroke's activation. Otherwise it first sends `progress("waiting for a click in seven's tab: choose a serial port")`, then answers the prompt bios shows: `{ title: 'Choose a serial port', body: '<asker> wants to use a serial port. Click Choose, then pick it in the browser\'s list.', action: 'Choose…', cancel: 'Cancel', variant: 'confirmation', dismissed: 'no serial port was chosen', late: 'nobody clicked within 5 min' }`, where the asker is `The agent <id>` for an agent's tag and `A program` otherwise. It answers `null` when the switch is off or there is no Web Serial, so `handle` refuses at once. No other kind prompts.
- **`ports`:** `list()` gives the ports `serial.list` would, and `open()` the open ones, as `{ handle, usbVendorId?, usbProductId?, bluetoothServiceClassId?, open }`. `close(handle)` closes one in seven (an unknown or closed handle does nothing), and `closeAll()` every open one, which is what turning the switch off does. `watch(listener)` calls `listener` with `{ type: 'open', handle, info, stamp, since }` when a port opens (`stamp` names the asker, `since` is `Date.now()`) and `{ type: 'close', handle, why }` when it closes, however it closes (`why` is `closed` for `serial.close`, `seven` for `ports.close` and `closeAll`, `unplugged` when it went away), and returns a function that stops it. bios adds the live item on `open`, with `Close` running `ports.close(handle)`, and removes it on `close`.
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

`session: false` drops the session's own user from the kernel's allow-list, so `serial.write` and `serial.control` are root's alone (for an agent, `sudo`), and the other kinds are for root and the members of `dialout` (gid 20).

### Handles

- `serial1`, `serial2`, … are numbered in the order the page first sees a port: from `getPorts()` at the first request, then the ports the chooser grants and the ones that connect.
- A handle stays the same for the page's lifetime. It lives in the tab whose page answers: another seven tab has its own numbering, and opening a port that tab holds open fails.
- **Re-enumeration:** when a granted port disconnects and a port with the same `usbVendorId:usbProductId` connects again (an esptool reset), it takes the old handle back, closed.
- **Unplugged:** a port that is open when it vanishes closes, and its reads end with `EIO` (`serial1 was unplugged`), as does any request for its handle until it comes back.

### Reading

- From `open`, the page reads the port continuously into a 1 MiB buffer, so data isn't lost between `read` requests.
- When the buffer is full, the oldest bytes are dropped. The next `read` first sends `progress('serial1: <n> bytes dropped (nobody read in time)')`.
- A `read` takes from that buffer, then from the port, as the program reads its reply: the page's stream has no queue of its own, so `/dev/embedder` paces it by the program. Only one `read` at a time per handle; a second one fails (`another read is in progress on serial1`). What a read doesn't take stays in the buffer.
- A `read` ends at end of file when the port closes, and with an error when it is unplugged. Ending the request (`^C`, closing the description) ends the read and leaves the rest buffered.

### Writing

The body goes to the port's writer through `writer.ready`, so the page reads the body only as fast as the port takes it, and the kernel's 1 MiB window holds a fast writer back. The reply comes after the body ends and the port has taken the last of it. Writes to one port run one after another.

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

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks.
- `npm test`: the integration tests in `test/integration/`. No test touches a real serial, USB, HID or Bluetooth device: `fake-devices.mjs` has a fake `navigator.serial` (`FakeSerial`, with `getPorts()`, a scripted chooser, `plug()` and `unplug()`) and fake ports (`FakeSerialPort`, with `ReadableStream`/`WritableStream`, `feed()`, an echo or a slow sink, and signals), and wraps the page module in a test `/dev/embedder` hook (`embedder(page, kinds, { gesture })`) that runs its `prompts` as bios's `plugged()` does, with a stubbed gesture; `request()` makes a kernel-shaped request and `errno()` the kernel's mapping of an error.
  - `scenarios.mjs` holds the page module's rows (list, request, open, read with bytes, until and timeouts, follow, writes and their pacing, the 4 MiB limits, the buffer overflow, signals, close, unplug and re-enumeration, and console's read and writes together), each with its expected result. `page.test.mjs` runs them in Node, and `browser.test.mjs` runs the same rows in Chrome.
  - `page.test.mjs` also runs requests through `/dev/embedder`, and `command.test.mjs` runs `serial` on `@ai-ecoverse/slicc-kernel/node` (pinned exactly) with wasm-bash and wasm-coreutils (`kernel.mjs`): every subcommand and output format, the usage errors, ^C, `console` on a terminal, outside SLICC, and the permission rows (a `dialout` member reads but can't write, `sudo serial write` works, a user outside `dialout` gets nothing).
  - `browser.test.mjs` drives Chrome through slicc-shared-web's harness, over a CDP pipe and no TCP port; it runs on CI only, and is skipped without `CI`. Besides the rows, it runs `serial` end to end in the browser kernel (the command, the `/dev/embedder` relay, the page module and the fake), with a real keystroke's activation for `serial request`.
  - `repo.test.mjs` checks the workflow, the release config, the pinned devDependencies, the exports, the `serial` command and what `npm pack` ships.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, then on a pull request the reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`.

## License

Apache-2.0
