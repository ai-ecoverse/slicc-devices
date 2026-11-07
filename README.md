# slicc-devices

Device access for SLICC through the browser's own device APIs: Web Serial first, then esptool, WebUSB, WebHID and Web Bluetooth LE. The kernel runs commands in a worker, which has none of these APIs, so a command asks seven's page over [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder), and this package's page module answers in the page.

For now the page module answers no kind and the package has no commands. The sections below that say so are filled as each device lands.

## Install

slicc-bios bundles `@ai-ecoverse/slicc-devices/page` and registers it on its `/dev/embedder` hook through `plugged()`, as it does `@ai-ecoverse/slicc-capture/page`. The commands will come in `slicc.commands`, so `pnpm add -g @ai-ecoverse/slicc-devices` puts them in `/usr/bin`. They need slicc-kernel 1.153.0 or later (`engines.slicc-kernel`), for `/dev/embedder`.

## Commands

None yet. `serial` is the first, with Web Serial.

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
import devices from '@ai-ecoverse/slicc-devices/page';

createKernel({ requests: { kinds: devices.kinds, handle: devices.handle } });
```

- **The exports:** `kinds`, the kinds it answers with their policies (empty for now); `handle(request)`, a [`/dev/embedder` hook](https://github.com/ai-ecoverse/slicc-kernel#devembedder)'s `handle`, which gets the kernel's `{ kind, options, body, stamp, signal, progress }`; `create()`, which returns another `{ kinds, handle }`; and the default export, `{ kinds, handle }`.
- **A kind it doesn't know:** `handle` rejects with a `NotSupportedError` `slicc-devices does not answer <kind>`, which the kernel turns into `ENOTSUP`. A kind the hook doesn't list never reaches it: the kernel answers `ENOTSUP` itself.

## Serial

To come: the `serial.*` kinds and their policies, the `serial` command, handles, reading and writing, and errors.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks.
- `npm test`: the integration tests in `test/integration/`. No test touches a real serial, USB, HID or Bluetooth device: `fake-devices.mjs` installs a fake `navigator.serial` (a `getPorts()` and a scripted `requestPort()`, extended for each device) and wraps the page module in a test `/dev/embedder` hook (`embedder(page, kinds)`), with `request()` for a kernel-shaped request and `errno()` for the kernel's mapping of an error. `page.test.mjs` registers that hook with `@ai-ecoverse/slicc-kernel/node` (the newest kernel, pinned exactly) and wasm-bash and wasm-coreutils (`kernel.mjs`), and runs requests through `/dev/embedder`. `browser.test.mjs` loads the module in Chrome through slicc-shared-web's harness, which drives Chrome over a CDP pipe and no TCP port; it runs on CI only, and is skipped without `CI`. `repo.test.mjs` checks the workflow, the release config, the pinned devDependencies, the exports and what `npm pack` ships.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, then on a pull request the reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`.

## License

Apache-2.0
