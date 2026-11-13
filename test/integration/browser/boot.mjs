import { attachKernel, createKernel } from '/kernel/index.js';
import devices from '/page/index.mjs';
import { embedder, FakeSerial, FakeSerialPort, install } from '/test/fake-devices.mjs';
import { FakeEsp } from '/test/fake-esp.mjs';

const typist = JSON.stringify({ kind: 'user', where: 'terminal:1' });

window.boot = async (files) => {
  const serial = new FakeSerial({
    ports: [new FakeSerialPort({ usbVendorId: 0x2e8a, usbProductId: 0x0005 })],
    choose: () => new FakeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 }, { echo: true }),
    activation: () => navigator.userActivation.isActive,
  });
  install(navigator, { serial });
  const hook = embedder(devices);
  const kernel = await createKernel({
    requests: hook,
    devices: devices.devices,
    metadata: false,
    ca: false,
    media: false,
    users: 'off',
  });
  const client = await attachKernel(await kernel.connect());
  const manifestsLast = [...files].sort(
    ([, a], [, b]) => Number(a.endsWith('/package.json')) - Number(b.endsWith('/package.json'))
  );
  for (const [url, path] of manifestsLast) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await client.fs.mkdir(path.slice(0, path.lastIndexOf('/')));
    await client.fs.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  }
  const probe = await fetch('/test/tty-probe.mjs');
  await client.fs.mkdir('/node_modules/ttyprobe');
  await client.fs.writeFile(
    '/node_modules/ttyprobe/probe.mjs',
    new Uint8Array(await probe.arrayBuffer())
  );
  await client.fs.writeFile(
    '/node_modules/ttyprobe/package.json',
    new TextEncoder().encode(
      JSON.stringify({
        name: 'ttyprobe',
        version: '1.0.0',
        slicc: { commands: { ttyprobe: { abi: 'js', module: 'probe.mjs' } } },
      })
    )
  );
  const nodes = devices.devices.nodes(kernel);
  const run = (argv, options = {}) => kernel.run(argv, { cwd: '/tmp', ...options });
  const board = () =>
    serial.plug(
      new FakeSerialPort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }, { device: new FakeEsp() })
    );
  const bridge = () =>
    serial.plug(
      new FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x6001 }, { boot: 'hello' })
    );
  window.serial = { serial, hook, run, board, bridge, nodes, ports: devices.ports };
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    window.serial.requested = run(['serial', 'request', '--vid', '0x303a'], { tag: typist });
  });
  return true;
};
