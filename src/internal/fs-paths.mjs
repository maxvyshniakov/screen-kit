import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTERNAL_MEDIA_RE = /^(?:https?:|data:|blob:)/i;

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function fileExists(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileAtomic(targetPath, data, options) {
  const resolved = resolve(targetPath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = join(dirname(resolved), `.${basename(resolved)}-${randomUUID()}.tmp`);
  try {
    if (options !== undefined) {
      await writeFile(tempPath, data, options);
    } else {
      await writeFile(tempPath, data);
    }
    await rename(tempPath, resolved);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function moveFileAtomic(source, destination, fsOps = {}) {
  const mkdirFn = fsOps.mkdir ?? mkdir;
  const renameFn = fsOps.rename ?? rename;
  const copyFileFn = fsOps.copyFile ?? copyFile;
  const rmFn = fsOps.rm ?? rm;

  await mkdirFn(dirname(destination), { recursive: true });
  try {
    await renameFn(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    const tempDest = `${destination}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await copyFileFn(source, tempDest);
      await renameFn(tempDest, destination);
      await rmFn(source, { force: true });
    } catch (copyError) {
      await rmFn(tempDest, { force: true }).catch(() => {});
      throw copyError;
    }
  }
}

export function resolveLocalPath(ref, baseDir = process.cwd()) {
  if (typeof ref !== 'string' || ref.trim().length === 0 || EXTERNAL_MEDIA_RE.test(ref)) {
    return null;
  }
  if (ref.startsWith('file://')) {
    return fileURLToPath(ref);
  }
  return resolve(baseDir, ref);
}

export function rebaseMediaRef(ref, fromBaseDir, toBaseDir) {
  if (typeof ref !== 'string' || ref.trim().length === 0 || EXTERNAL_MEDIA_RE.test(ref)) {
    return ref;
  }
  const abs = resolveLocalPath(ref, fromBaseDir);
  if (!abs) return ref;
  if (!toBaseDir) return abs;
  const rel = relative(resolve(toBaseDir), abs);
  return rel || basename(abs);
}

export function assertPathInsideDir(filePath, baseDir, label = 'output path') {
  const resolvedBase = resolve(baseDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedBase, resolvedFile);
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    isAbsolute(rel)
  ) {
    throw Error(`${label} escapes base directory (${resolvedBase}): ${filePath}`);
  }
  return resolvedFile;
}
