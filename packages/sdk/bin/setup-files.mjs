import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, opendirSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const fail = (code) => { throw new Error(code); };
const limit = 65_536;
function targetPath(root, filename, createParents) {
  if (typeof filename !== "string" || !filename || isAbsolute(filename)) fail("unsafe_file_path");
  const base = realpathSync(root), target = resolve(base, filename), local = relative(base, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) fail("unsafe_file_path");
  let parent = base;
  for (const part of relative(base, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    if (createParents) {
      try { mkdirSync(parent, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const entry = lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unsafe_file_path");
  }
  return { target, local };
}
function recoverPublication(target, fd, entry) {
  // A crash after exclusive publication can leave our second, temporary link.
  // Remove only reserved publication names pointing at this exact inode; an
  // unrelated hardlink remains a permission failure. A live publisher tolerates
  // this cleanup in its own finally block as well.
  const prefix = `.commish-setup-${basename(target)}.`, directory = opendirSync(dirname(target));
  try {
    let item, scanned = 0;
    while ((item = directory.readSync()) && ++scanned <= 4096) {
      if (!item.name.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(item.name.slice(prefix.length))) continue;
      const temporary = join(dirname(target), item.name);
      try {
        const candidate = lstatSync(temporary);
        if (candidate.isFile() && candidate.dev === entry.dev && candidate.ino === entry.ino) unlinkSync(temporary);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } finally { directory.closeSync(); }
  if (fstatSync(fd).nlink !== 1) fail("unsafe_file_permissions");
}
function readFile(target, privateFile) {
  let fd;
  try {
    if (lstatSync(target).isSymbolicLink()) fail("unsafe_file_path");
    if (!Number.isInteger(constants.O_NOFOLLOW)) fail("unsupported_file_safety");
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > limit) fail("invalid_setup_file");
    if (privateFile && (entry.mode & 0o077) !== 0) fail("unsafe_file_permissions");
    if (privateFile && entry.nlink !== 1) recoverPublication(target, fd, entry);
    const bytes = Buffer.alloc(limit + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > limit) fail("invalid_setup_file");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { fail("invalid_setup_file"); }
  } finally { if (fd !== undefined) closeSync(fd); }
}
const known = new Set(["unsafe_file_path", "unsafe_file_permissions", "invalid_setup_file", "setup_file_conflict", "unsupported_file_safety"]);
function sanitized(error) { fail(known.has(error?.message) ? error.message :
  error?.code === "ENOENT" ? "setup_file_missing" : error?.code === "ELOOP" ? "unsafe_file_path" : "setup_file_unavailable"); }

// Callers validate file contents before using them. Files stay within the
// selected repository; symlink components and special files are rejected.
export function readSetupFile(root, filename, { privateFile = false } = {}) {
  try { return readFile(targetPath(root, filename, false).target, privateFile); }
  catch (error) { sanitized(error); }
}

// Publish a completely written file exclusively. Existing custom content is
// never replaced, even when another process wins the creation race.
export function writeSetupFile(root, filename, body, { privateFile = false } = {}) {
  let temporary, fd;
  try {
    if (typeof body !== "string" || Buffer.byteLength(body) > limit) fail("invalid_setup_file");
    const { target, local } = targetPath(root, filename, true);
    try {
      if (readFile(target, privateFile) !== body) fail("setup_file_conflict");
      return { path: local, written: false };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Number.isInteger(constants.O_NOFOLLOW)) fail("unsupported_file_safety");
    temporary = join(dirname(target), `.commish-setup-${basename(target)}.${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, privateFile ? 0o600 : 0o644);
    writeFileSync(fd, body, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (readFile(target, privateFile) !== body) fail("setup_file_conflict");
      return { path: local, written: false };
    }
    return { path: local, written: true };
  } catch (error) { sanitized(error); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) { try { unlinkSync(temporary); } catch {} }
  }
}
