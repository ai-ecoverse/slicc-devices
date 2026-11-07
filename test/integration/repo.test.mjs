import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the repository', () => {
  it('has ci.yml as its only workflow, on the pipeline at the devDependency version', () => {
    assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['ci.yml']);
    const ci = read('.github/workflows/ci.yml');
    const uses = [...ci.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    assert.deepEqual(uses, [
      `ai-ecoverse/slicc-shared-web/.github/workflows/pipeline.yml@v${pkg.devDependencies['@ai-ecoverse/slicc-shared-web']}`,
    ]);
    assert.match(ci, /^jobs:\n {2}ci:$/m);
    assert.match(ci, /^\s*secrets: inherit$/m);
    assert.doesNotMatch(ci, /runs-on|workflow_dispatch|schedule|windows-test|#/);
    for (const scope of [
      'contents',
      'issues',
      'pull-requests',
      'statuses',
      'id-token',
      'attestations',
    ]) {
      assert.match(ci, new RegExp(`^  ${scope}: write$`, 'm'), scope);
    }
    assert.match(ci, /^ {2}actions: read$/m);
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    assert.match(ci, /^\s*review-prompt: \|\n\s+SLICC-DEVICES$/m);
    assert.match(ci, /^ {6}shards: 1$/m);
    const glob = /^\s*test-glob:\s*(\S+)$/m.exec(ci)?.[1];
    assert.ok(glob && pkg.scripts.test.endsWith(` ${glob}`), pkg.scripts.test);
    assert.equal(pkg.devDependencies['@ai-ecoverse/slicc-shared-web'].split('.')[0], '2');
  });

  it('pins every devDependency exactly', () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(-\d+)?$/, name);
    }
    assert.equal(pkg.engines.node, '>=24');
    assert.equal(pkg.engines['slicc-kernel'], '>=1.176.0');
    const kernel = pkg.devDependencies['@ai-ecoverse/slicc-kernel'];
    const parts = (version) => version.split('.').map(Number);
    const order = (a, b) => a.reduce((sign, part, i) => sign || Math.sign(part - b[i]), 0);
    assert.ok(order(parts(kernel), parts(pkg.engines['slicc-kernel'].slice(2))) >= 0, kernel);
  });

  it('publishes to npm from ci.yml through semantic-release, with provenance', () => {
    assert.equal(pkg.name, '@ai-ecoverse/slicc-devices');
    assert.deepEqual(pkg.fledgling, {
      provider: 'github',
      workflow: 'ci.yml',
      repo: 'ai-ecoverse/slicc-devices',
      publish: true,
    });
    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(pkg.publishConfig.provenance, true);
    const release = JSON.parse(read('.releaserc.json'));
    assert.deepEqual(release.branches, ['main']);
    assert.ok(release.plugins.some((entry) => [entry].flat()[0] === '@semantic-release/npm'));
    assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  });

  it('keeps unit tests and CLAUDE.md out of git, and no .md files but README.md and AGENTS.md', () => {
    assert.match(read('.gitignore'), /^test\/unit\/$/m);
    const tracked = spawnSync('git', ['ls-files', 'test/unit', '*CLAUDE.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout, '');
    const docs = spawnSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' });
    assert.equal(docs.status, 0, docs.stderr);
    assert.deepEqual(docs.stdout.split('\n').filter(Boolean).sort(), ['AGENTS.md', 'README.md']);
  });

  it('exports ./page and ./package.json, which resolve', async () => {
    assert.deepEqual(pkg.exports, {
      './page': './page/index.mjs',
      './package.json': './package.json',
    });
    const page = await import('@ai-ecoverse/slicc-devices/page');
    assert.equal(typeof page.handle, 'function');
    assert.equal(typeof page.default.handle, 'function');
    assert.equal(
      import.meta.resolve('@ai-ecoverse/slicc-devices/package.json').endsWith('/package.json'),
      true
    );
  });

  it('ships serial as one self-contained JS program', () => {
    assert.deepEqual(pkg.slicc.commands, {
      serial: { abi: 'js', module: 'bin/serial.mjs', env: { SLICC_PACKAGE: '${package}' } },
    });
    assert.doesNotMatch(read('bin/serial.mjs'), /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m);
  });

  it('collects unit coverage from every shipped source directory', () => {
    assert.deepEqual([...pkg.slicc.unitSources].sort(), [...pkg.files].sort());
  });

  it('packs every file that exports, bin and slicc.commands name, and no tests', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(pack.status, 0, pack.stderr);
    const files = JSON.parse(pack.stdout)[0]
      .files.map((file) => file.path)
      .sort();
    const shipped = (pkg.files ?? []).flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => `${dir}/${name}`)
    );
    assert.deepEqual(files, ['LICENSE', 'README.md', 'package.json', ...shipped].sort());
    for (const path of Object.values(pkg.exports)) assert.ok(files.includes(path.slice(2)), path);
    for (const [name, command] of Object.entries(pkg.slicc?.commands ?? {})) {
      assert.ok(files.includes(command.module ?? command.script), name);
    }
    for (const [name, path] of Object.entries(pkg.bin ?? {})) assert.ok(files.includes(path), name);
  });
});
