import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyThemeFiles, defaultThemeDestination } from '../scripts/deploy-theme.mjs';
import { themeFiles, obsoleteThemeFiles } from '../scripts/theme-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pendant-deployment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'build');
  for (const file of themeFiles) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), `new simulator content: ${file}`);
  }
  // Files accidentally left in a build directory must not reach the theme.
  await writeFile(join(source, 'assets/unrelated.js'), 'do not deploy');
  return { root, source, target: join(root, 'theme') };
}

test('default destination is the sibling theme, independent of the current directory', () => {
  assert.equal(defaultThemeDestination, resolve(import.meta.dirname, '../../my-shopify-theme'));
});

test('copies exactly the three integration files and creates only their missing theme directories', async t => {
  const { source, target } = await fixture(t);
  const copied = await copyThemeFiles(target, source);
  assert.deepEqual(copied, themeFiles.map(file => join(target, file)));
  for (const file of themeFiles) assert.deepEqual(await readFile(join(target, file)), await readFile(join(source, file)));
  assert.deepEqual((await readdir(join(target, 'assets'))).sort(), ['pendant-simulator.css', 'pendant-simulator.js']);
  assert.deepEqual((await readdir(target)).sort(), ['assets', 'blocks']);
});

test('repeated deployment updates simulator files while preserving unrelated theme and Git files', async t => {
  const { source, target } = await fixture(t);
  const unrelated = ['assets/theme.js', 'assets/unrelated.js', 'layout/theme.liquid',
    'templates/product.json', 'config/settings_data.json', '.git/config', '.git/HEAD'];
  for (const file of unrelated) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), `original: ${file}`);
  }
  await copyThemeFiles(target, source);
  await writeFile(join(source, themeFiles[0]), 'updated simulator');
  await copyThemeFiles(target, source);
  assert.equal(await readFile(join(target, themeFiles[0]), 'utf8'), 'updated simulator');
  for (const file of unrelated) assert.equal(await readFile(join(target, file), 'utf8'), `original: ${file}`);
  assert.ok(!(await readdir(join(target, 'assets'))).some(file => file.endsWith('.tmp')));
});

test('missing build files fail before creating or modifying the destination', async t => {
  const { source, target } = await fixture(t);
  await rm(join(source, themeFiles.at(-1)));
  await assert.rejects(copyThemeFiles(target, source), /Missing Shopify build file/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('migration removes only the two obsolete owned files and repeated deployment is safe', async t => {
  const { source, target } = await fixture(t);
  const unrelated = ['sections/product.liquid', 'snippets/other-assets.liquid', 'templates/product.json', 'layout/theme.liquid'];
  for (const file of [...obsoleteThemeFiles, ...unrelated]) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), `existing: ${file}`);
  }
  await copyThemeFiles(target, source);
  await copyThemeFiles(target, source);
  for (const file of obsoleteThemeFiles) await assert.rejects(access(join(target, file)), { code: 'ENOENT' });
  for (const file of unrelated) assert.equal(await readFile(join(target, file), 'utf8'), `existing: ${file}`);
});

test('a symlink at an obsolete path is rejected before any copy or removal', async t => {
  const { root, source, target } = await fixture(t);
  const unrelated = join(root, 'keep.liquid');
  await writeFile(unrelated, 'keep this');
  await mkdir(join(target, 'snippets'), { recursive: true });
  await symlink(unrelated, join(target, obsoleteThemeFiles[0]));
  await assert.rejects(copyThemeFiles(target, source), /symlink destination/);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep this');
  await assert.rejects(access(join(target, themeFiles[0])), { code: 'ENOENT' });
});

test('destination conflicts and symlinks cannot overwrite unrelated files', async t => {
  const { root, source, target } = await fixture(t);
  const unrelated = join(root, 'keep.js');
  await mkdir(join(target, 'assets'), { recursive: true });
  await writeFile(unrelated, 'keep this');
  await symlink(unrelated, join(target, themeFiles[0]));
  await assert.rejects(copyThemeFiles(target, source), /symlink destination/);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep this');
  await assert.rejects(access(join(target, themeFiles[1])), { code: 'ENOENT' });
  await rm(target, { recursive: true });
  await mkdir(target);
  await symlink(root, join(target, 'assets'));
  await assert.rejects(copyThemeFiles(target, source), /symlink destination/);
});

test('the simulator repository cannot accidentally become the theme destination', async t => {
  const { source } = await fixture(t);
  await assert.rejects(copyThemeFiles(resolve(import.meta.dirname, '..'), source), /outside the simulator repository/);
  await assert.rejects(copyThemeFiles(resolve(import.meta.dirname, '../dist/theme-copy'), source), /outside the simulator repository/);
});

test('a failed production build prevents the CLI from copying any theme files', async t => {
  const { root, target } = await fixture(t);
  const failingBuild = join(root, 'failing-npm.mjs');
  await writeFile(failingBuild, 'process.exit(23);');
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../scripts/deploy-theme.mjs'), target], {
    env: { ...process.env, npm_execpath: failingBuild },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Shopify build failed \(23\); no theme files copied/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});
