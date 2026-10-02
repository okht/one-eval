import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeProvenance {
  version: 1;
  oneEvalVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  implementationHash: string;
  dependencies: Record<string, string>;
}

const moduleFile = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(moduleFile);
const packageDirectory = path.resolve(moduleDirectory, '..');
const require = createRequire(import.meta.url);

async function dependencyVersion(name: string): Promise<string> {
  // Packages may expose only subpaths, with neither a root entry nor package.json.
  // Use Node's own lookup paths in that case, including hoisted installations.
  let directory: string;
  try { directory = path.dirname(require.resolve(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    for (const lookup of require.resolve.paths(name) ?? []) {
      try {
        const metadata = JSON.parse(await readFile(path.join(lookup, name, 'package.json'), 'utf8'));
        if (metadata.name === name && typeof metadata.version === 'string') return metadata.version;
      } catch (lookupError) { if ((lookupError as NodeJS.ErrnoException).code !== 'ENOENT') throw lookupError; }
    }
    throw new Error(`Cannot resolve installed dependency version: ${name}`);
  }
  for (;;) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name && typeof metadata.version === 'string') return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot resolve installed dependency version: ${name}`);
    directory = parent;
  }
}

/** Local runtime evidence; this never claims to identify a remote model build. */
export async function getRuntimeProvenance(): Promise<RuntimeProvenance> {
  const metadata = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (typeof metadata.version !== 'string') throw new Error('The installed one-eval package has no version');
  const extension = path.extname(moduleFile);
  const sources = (await readdir(moduleDirectory)).filter(name => name.endsWith(extension) && !name.endsWith('.d.ts')).sort();
  const hash = createHash('sha256');
  for (const name of sources) {
    const bytes = await readFile(path.join(moduleDirectory, name));
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  const dependencies: Record<string, string> = Object.create(null);
  for (const name of Object.keys(metadata.dependencies ?? {}).sort()) dependencies[name] = await dependencyVersion(name);
  return {
    version: 1, oneEvalVersion: metadata.version, nodeVersion: process.version,
    platform: process.platform, arch: process.arch,
    implementationHash: hash.digest('hex'), dependencies,
  };
}
