// Copies output/model.glb for a score-over-time snapshot (snapshots.mjs,
// readSnapshot) while the contestant is still running. The runner starts this
// process with output/ as its working directory, so every path below is
// resolved from that directory itself, never again through the workspace:
// whatever the contestant does to the name output/ meanwhile (renames it,
// swaps a symlink in and out), '.' stays the directory this process entered.
// That directory must be the one the attempt started with (device and inode,
// recorded before the launch); had output/ been a symlink to somewhere else
// when this process started, '.' would be that somewhere else, and nothing is
// read. Node has no openat(); a working directory is the descriptor it lacks.
//   node snapshot-read.mjs '<job JSON>'   (cwd: <workspace>/output)
// job: { dev, ino, maxBytes, dest, known }. Prints one JSON line,
// { present, problem, retry, bytes, sha256, complete, stable, written, write_error };
// the bytes go to `dest` (created exclusively) when there is no problem and
// their sha256 is not in `known` (content the runner already stored).
import { open, lstat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { glbComplete } from './snapshots.mjs';

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Opened without following a symlink and without blocking (a FIFO would hang
// an ordinary open), checked on the open handle (a regular file, one link,
// within the byte budget) and read from it; then model.glb must still be the
// file that was read. A file replaced meanwhile (an atomic rename by the
// model, or a swap) is read again by the runner (`retry`).
async function read({ dev, ino, maxBytes }) {
  const here = await lstat('.', { bigint: true });
  if (!sameNode(here, { dev: BigInt(dev), ino: BigInt(ino) })) return { present: true, problem: 'output/ is not the directory the attempt started with', retry: true };
  let handle;
  try { handle = await open('model.glb', OPEN_FLAGS); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, problem: null };
    if (error.code === 'ELOOP' || error.code === 'EMLINK') return { present: true, problem: 'artifact is a symlink' };
    return { present: false, problem: 'output/model.glb could not be opened (' + (error.code ?? error.message) + ')' };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { present: true, problem: 'artifact is not a regular file' };
    if (before.nlink !== 1n) return { present: true, problem: 'artifact has ' + before.nlink + ' hard links' };
    if (before.size > BigInt(maxBytes)) return { present: true, bytes: Number(before.size), problem: 'artifact is ' + before.size + ' bytes, over the ' + maxBytes + ' byte budget' };
    const data = Buffer.alloc(Number(before.size));
    let got = 0;
    while (got < data.length) {
      const { bytesRead } = await handle.read(data, got, data.length - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat('model.glb', { bigint: true }).catch(() => null);
    if (after.nlink !== 1n) return { present: true, problem: 'artifact has ' + after.nlink + ' hard links' };
    if (!named || !sameNode(named, after)) return { present: true, problem: 'output/model.glb was replaced while it was read', retry: true };
    const bytes = data.subarray(0, got);
    return { present: true, problem: null, data: bytes, bytes: got, sha256: createHash('sha256').update(bytes).digest('hex'), complete: glbComplete(bytes),
      stable: got === data.length && after.size === before.size && after.mtimeNs === before.mtimeNs };
  } finally { await handle.close().catch(() => {}); }
}

const job = JSON.parse(process.argv[2]);
const found = await read(job);
if (found.data) {
  if (job.dest && !(job.known ?? []).includes(found.sha256)) {
    try { await writeFile(job.dest, found.data, { flag: 'wx' }); found.written = true; }
    catch (error) { found.write_error = error.message; }
  }
  delete found.data;
}
process.stdout.write(JSON.stringify(found) + '\n');
