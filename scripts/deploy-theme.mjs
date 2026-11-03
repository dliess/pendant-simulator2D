import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeFiles, obsoleteThemeFiles } from './theme-files.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const defaultThemeDestination = resolve(projectRoot, '../my-shopify-theme');

async function existingInfo(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Resolve existing ancestors as well, so aliases cannot put the destination
// inside the simulator repository when the final directories do not exist yet.
async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function copyThemeFiles(destination, source = resolve(projectRoot, 'dist/shopify-theme')) {
  const target = resolve(projectRoot, destination);
  const canonicalTarget = await canonicalPath(target);
  const withinProject = relative(await realpath(projectRoot), canonicalTarget);
  if (!withinProject || (!isAbsolute(withinProject) && withinProject !== '..' && !withinProject.startsWith(`..${sep}`))) {
    throw new Error('The theme destination must be outside the simulator repository');
  }

  // Check every source and destination before making changes. Never recurse
  // through the theme or follow a symlink to an unrelated asset/directory.
  for (const file of themeFiles) {
    const info = await existingInfo(join(source, file));
    if (!info?.isFile()) throw new Error(`Missing Shopify build file: ${join(source, file)}`);
  }
  const directories = [target, ...new Set(themeFiles.map(file => dirname(join(target, file))))];
  const checkedDirectories = new Set([
    ...directories, ...obsoleteThemeFiles.map(file => dirname(join(target, file))),
  ]);
  for (const directory of checkedDirectories) {
    const info = await existingInfo(directory);
    if (info && !info.isDirectory()) throw new Error(`Refusing non-directory or symlink destination: ${directory}`);
  }
  for (const file of [...themeFiles, ...obsoleteThemeFiles]) {
    const path = join(target, file);
    const info = await existingInfo(path);
    if (info && !info.isFile()) throw new Error(`Refusing non-file or symlink destination: ${path}`);
  }

  for (const directory of directories) await mkdir(directory, { recursive: true });
  for (const file of themeFiles) {
    const path = join(target, file);
    const temporary = join(dirname(path), `.pendant-deploy-${randomUUID()}.tmp`);
    try {
      await copyFile(join(source, file), temporary, constants.COPYFILE_EXCL);
      // Replace only the named file, without truncating a hard-linked file or
      // leaving a half-written JS bundle if copying is interrupted.
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const file of obsoleteThemeFiles) await rm(join(target, file), { force: true });
  return themeFiles.map(file => join(target, file));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: npm run deploy:theme -- [theme-directory]');
    console.log(`Default: ${defaultThemeDestination}`);
    console.log('Builds and copies simulator files locally. Does not publish to Shopify.');
    return;
  }
  if (args.length > 1 || (args.length === 1 && (!args[0].trim() || args[0].startsWith('--')))) {
    throw new Error('Usage: npm run deploy:theme -- [theme-directory]');
  }
  const destination = args[0] ?? defaultThemeDestination;
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI) throw new Error('Run this command through npm: npm run deploy:theme');
  const build = spawnSync(process.execPath, [npmCLI, 'run', 'build:shopify'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Shopify build failed (${build.signal ?? build.status}); no theme files copied`);
  const copied = await copyThemeFiles(destination);
  console.log(`\nInstalled ${copied.length} simulator files locally:`);
  copied.forEach(file => console.log(`  ${file}`));
  console.log('Removed obsolete simulator snippet and section files when present.');
  console.log('No Shopify upload, Git operation, or unrelated theme file changes were performed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
