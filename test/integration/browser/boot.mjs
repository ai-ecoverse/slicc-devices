import { attachKernel, createKernel } from '/kernel/index.js';
import devices from '/page/index.mjs';
import { embedder, FakeSerial, FakeSerialPort, install } from '/test/fake-devices.mjs';

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
  const run = (argv, options = {}) => kernel.run(argv, { cwd: '/tmp', ...options });
  window.serial = { serial, hook, run };
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    window.serial.requested = run(['serial', 'request', '--vid', '0x303a'], { tag: typist });
  });
  return true;
};
