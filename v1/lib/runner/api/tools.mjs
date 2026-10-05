import { realpathSync } from 'node:fs';
import { lstat, stat, realpath, readdir, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { decodePNG, encodePNG } from '../../png.mjs';
import { runSandboxed, READ_ONLY_PARTS } from './sandbox.mjs';

// The five tools of the API systems, with one definition for both providers
// (each provider wraps name, description and schema in its own envelope).
// The shell runs under the Seatbelt profile (sandbox.mjs). The file tools run
// in the loop's own process, outside the sandbox, so they confine themselves:
// a path is resolved against the workspace, must stay inside it lexically
// (no absolute path elsewhere, no `..` out) and after resolving symlinks
// (realpath; a dangling link does not resolve and is refused), a file with
// more than one hard link is refused (except the runtime under node_modules/,
// which the runner hard-links in itself and which is read-only to the shell),
// and a write must land in a writable part (not input/, tools/, node_modules/),
// never through a symlink as its last component, and never into a file with
// more than one link. Preflight proves this on the same canaries and escape
// routes as the CLI tracks.
export const OUTPUT_LIMIT = 20000;
export const SHELL_TIMEOUT = { default: 120, max: 300 };
// view_image: images are sent to the model at most this size on a side (the
// Claude API applies a 2000 px limit per image once a request holds more than
// 20 images, and every image stays in the history) and at most this many
// bytes (the Claude API takes 10 MB of base64 per image).
export const IMAGE_MAX_SIDE = 2000;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// read_file reads at most this many bytes of a file.
const READ_MAX_BYTES = 4 * 1024 * 1024;

const pathProperty = description => ({ type: 'string', description });

export const TOOL_SPECS = [
  {
    name: 'shell',
    description: 'Run a bash command in the working directory and return its combined stdout and stderr (at most 20,000 characters: ' +
      'the beginning and the end of longer output) and its exit code. Node.js is on PATH. There is no network.',
    schema: { type: 'object', properties: {
      command: { type: 'string', description: 'The command, run with /bin/bash -c.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: SHELL_TIMEOUT.max, description: 'Stop the command after this many seconds (default ' + SHELL_TIMEOUT.default + ', at most ' + SHELL_TIMEOUT.max + ').' },
    }, required: ['command'], additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a text file and return its contents (at most 20,000 characters).',
    schema: { type: 'object', properties: { path: pathProperty('Path of the file, relative to the working directory.') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: 'Write a text file, replacing it if it exists and creating missing directories. input/, tools/ and node_modules/ are read-only.',
    schema: { type: 'object', properties: { path: pathProperty('Path of the file, relative to the working directory.'), content: { type: 'string', description: 'The whole new content of the file.' } },
      required: ['path', 'content'], additionalProperties: false },
  },
  {
    name: 'list_dir',
    description: 'List a directory: one entry per line, directories with a trailing /, files with their size in bytes.',
    schema: { type: 'object', properties: { path: pathProperty('Path of the directory, relative to the working directory; "." for the working directory itself.') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'view_image',
    description: 'Show you a PNG or JPEG image file. Images larger than ' + IMAGE_MAX_SIDE + ' pixels on a side are shown scaled down (PNG) or refused (JPEG).',
    schema: { type: 'object', properties: { path: pathProperty('Path of the image, relative to the working directory.') }, required: ['path'], additionalProperties: false },
  },
];
export const API_TOOL_NAMES = TOOL_SPECS.map(spec => spec.name);

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };

const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
};

// Truncates text to `limit` characters, keeping the beginning and the end.
export function clip(text, limit = OUTPUT_LIMIT, total = text.length) {
  if (text.length <= limit && total <= text.length) return { text, truncated: false };
  const half = Math.floor(limit / 2);
  return { text: text.slice(0, half) + '\n[... ' + (total - 2 * half) + ' characters left out ...]\n' + text.slice(-half), truncated: true };
}

// ---------------------------------------------------------------- images

function pngSize(bytes) {
  return bytes.length >= 24 && bytes.readUInt32BE(12) === 0x49484452 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = bytes.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

// A box-filtered reduction of a decoded PNG to fit IMAGE_MAX_SIDE.
function downscale(image) {
  const scale = Math.max(image.width, image.height) / IMAGE_MAX_SIDE;
  const width = Math.max(1, Math.round(image.width / scale)), height = Math.max(1, Math.round(image.height / scale)), channels = image.channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * image.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * image.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / width));
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += image.pixels[(yy * image.width + xx) * channels + c];
        out[(y * width + x) * channels + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { width, height, bytes: encodePNG(width, height, out, channels) };
}

export function prepareImage(bytes) {
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) refuse('not a PNG or JPEG file');
  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  if (!size) refuse('could not read the image size');
  let out = { media_type: isPng ? 'image/png' : 'image/jpeg', bytes, width: size.width, height: size.height, scaled_from: null };
  if (Math.max(size.width, size.height) > IMAGE_MAX_SIDE) {
    if (!isPng) refuse('the JPEG is ' + size.width + 'x' + size.height + ' pixels, larger than ' + IMAGE_MAX_SIDE + ' on a side; write a smaller image');
    let decoded;
    try { decoded = decodePNG(bytes); } catch (error) { refuse('the PNG is ' + size.width + 'x' + size.height + ' pixels and could not be scaled down (' + error.message + '); write a smaller image'); }
    const small = downscale(decoded);
    out = { media_type: 'image/png', bytes: small.bytes, width: small.width, height: small.height, scaled_from: size };
  }
  if (out.bytes.length > IMAGE_MAX_BYTES) refuse('the image is ' + out.bytes.length + ' bytes, more than ' + IMAGE_MAX_BYTES);
  return out;
}

// ---------------------------------------------------------------- the tools

export function createTools({ workspace, sandbox, limits = {} }) {
  const root = realpathSync(workspace), given = resolve(workspace);
  const outputLimit = limits.output_chars ?? OUTPUT_LIMIT;
  const readOnly = READ_ONLY_PARTS.map(part => join(root, part));
  const runtime = join(root, 'node_modules');

  // The workspace path a request names, before anything on disk is consulted.
  const lexical = path => {
    if (typeof path !== 'string' || !path.trim()) refuse('a path is required');
    if (path.includes('\0')) refuse('the path contains a NUL byte');
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (within(root, absolute)) return absolute;
    if (within(given, absolute)) return join(root, relative(given, absolute));
    refuse('the path is outside the working directory');
  };

  // Resolves a lexically confined path one component at a time, following a
  // symbolic link only when it resolves inside the workspace. A link that
  // leads outside, or nowhere, is refused with one message either way, so a
  // planted link cannot be used to learn whether a path outside exists.
  // Returns the real path and whether it exists; for a missing path, the
  // real path of its existing prefix with the missing components appended.
  const LINK_OUT = 'the path runs through a symbolic link that leads outside the working directory or nowhere';
  const walk = async absolute => {
    const parts = relative(root, absolute).split(sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const next = join(current, parts[i]);
      const info = await lstat(next).catch(error => ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : refuse('cannot read the path (' + error.code + ')'));
      if (!info) return { resolved: join(next, ...parts.slice(i + 1)), exists: false };
      if (info.isSymbolicLink()) {
        const target = await realpath(next).catch(() => null);
        if (!target || !within(root, target)) refuse(LINK_OUT);
        current = target;
      } else current = next;
    }
    return { resolved: current, exists: true };
  };

  // An existing file or directory, resolved and confined.
  const existing = async path => {
    const found = await walk(lexical(path));
    if (!found.exists) refuse('no such file or directory');
    return found.resolved;
  };

  const readable = async path => {
    const resolved = await existing(path), info = await stat(resolved);
    if (!info.isFile()) refuse(info.isDirectory() ? 'the path is a directory' : 'the path is not a regular file');
    if (info.nlink > 1 && !within(runtime, resolved)) refuse('the file has ' + info.nlink + ' hard links; it is not read through a link');
    return { resolved, info };
  };

  const readBytes = async (resolved, max) => {
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.min(size, max));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { bytes: buffer.subarray(0, bytesRead), size };
    } finally { await handle.close(); }
  };

  const tools = {
    async shell(args, { signal } = {}) {
      if (typeof args.command !== 'string' || !args.command.trim()) refuse('command must be a non-empty string');
      let seconds = args.timeout_seconds ?? SHELL_TIMEOUT.default;
      if (!Number.isFinite(seconds) || seconds < 1) refuse('timeout_seconds must be a number of seconds from 1 to ' + SHELL_TIMEOUT.max);
      seconds = Math.min(Math.round(seconds), SHELL_TIMEOUT.max);
      const run = await runSandboxed({ profile: sandbox.profile, env: sandbox.env, cwd: root, command: args.command, seconds, keepChars: outputLimit, signal });
      if (run.error && run.exit_code === null) return { ok: false, text: 'the command could not be started: ' + run.error, meta: { exit_code: null, timed_out: false, output_chars: 0, truncated: false } };
      const whole = run.head + (run.dropped ? '' : run.tail);
      const { text, truncated } = run.dropped ? { text: run.head.slice(0, outputLimit / 2) + '\n[... ' + (run.total_chars - outputLimit) + ' characters left out ...]\n' + run.tail.slice(-outputLimit / 2), truncated: true }
        : clip(whole, outputLimit);
      const status = run.timed_out ? '[timed out after ' + seconds + ' s; the command was killed]' : run.signal ? '[killed by ' + run.signal + ']' : '[exit code ' + run.exit_code + ']';
      return { ok: !run.timed_out && run.exit_code === 0, text: (text ? text.replace(/\n?$/, '\n') : '') + status,
        meta: { exit_code: run.exit_code, timed_out: run.timed_out, output_chars: run.total_chars, truncated, seconds } };
    },

    async read_file(args) {
      const { resolved, info } = await readable(args.path);
      const { bytes, size } = await readBytes(resolved, READ_MAX_BYTES);
      if (bytes.subarray(0, 8192).includes(0)) return { ok: false, text: 'binary file (' + size + ' bytes); use view_image for PNG and JPEG images, or the shell', meta: { bytes: size } };
      const decoded = bytes.toString('utf8');
      const { text, truncated } = clip(decoded, outputLimit, size > bytes.length ? decoded.length + (size - bytes.length) : decoded.length);
      return { ok: true, text, meta: { bytes: info.size, truncated } };
    },

    async write_file(args) {
      if (typeof args.content !== 'string') refuse('content must be a string');
      const absolute = lexical(args.path);
      if (absolute === root) refuse('the path is the working directory itself');
      // The parent resolves inside the workspace (missing directories are then
      // created as real directories below its existing, confined prefix).
      const parent = await walk(dirname(absolute));
      const target = join(parent.resolved, basename(absolute));
      if (!within(root, target)) refuse('the path is outside the working directory');
      if (readOnly.some(part => within(part, target))) refuse('input/, tools/ and node_modules/ are read-only');
      if (parent.exists) { if (!(await stat(parent.resolved)).isDirectory()) refuse('a parent of the path is not a directory'); }
      else await mkdir(parent.resolved, { recursive: true });
      const info = await lstat(target).catch(() => null);
      if (info?.isSymbolicLink()) refuse('the path is a symbolic link; files are not written through links');
      if (info && !info.isFile()) refuse('the path exists and is not a regular file');
      if (info && info.nlink > 1) refuse('the file has ' + info.nlink + ' hard links; it is not written through a link');
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(args.content, 'utf8'); } finally { await handle.close(); }
      return { ok: true, text: 'wrote ' + Buffer.byteLength(args.content) + ' bytes to ' + relative(root, target), meta: { bytes: Buffer.byteLength(args.content) } };
    },

    async list_dir(args) {
      const resolved = await existing(args.path);
      if (!(await stat(resolved)).isDirectory()) refuse('the path is not a directory');
      const entries = (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1);
      const lines = [];
      for (const entry of entries) {
        if (entry.isDirectory()) lines.push(entry.name + '/');
        else if (entry.isSymbolicLink()) lines.push(entry.name + '@ (symbolic link)');
        else if (entry.isFile()) lines.push(entry.name + ' (' + ((await lstat(join(resolved, entry.name)).catch(() => null))?.size ?? '?') + ' bytes)');
        else lines.push(entry.name + ' (other)');
      }
      const { text, truncated } = clip(lines.join('\n') || '(empty)', outputLimit);
      return { ok: true, text, meta: { entries: entries.length, truncated } };
    },

    async view_image(args) {
      const { resolved } = await readable(args.path);
      const { bytes, size } = await readBytes(resolved, 64 * 1024 * 1024);
      if (size > bytes.length) refuse('the file is too large');
      const image = prepareImage(bytes);
      const shown = image.scaled_from ? ', shown scaled down from ' + image.scaled_from.width + 'x' + image.scaled_from.height : '';
      return { ok: true, text: relative(root, resolved) + ': ' + image.media_type + ', ' + image.width + 'x' + image.height + shown,
        image: { media_type: image.media_type, data: image.bytes.toString('base64'), width: image.width, height: image.height },
        meta: { bytes: image.bytes.length, width: image.width, height: image.height, scaled: Boolean(image.scaled_from) } };
    },
  };

  // Runs one call. Never throws: refusals and errors come back as a failed
  // result whose text the model sees.
  return {
    root,
    async run(name, args, options = {}) {
      const tool = Object.hasOwn(tools, name) ? tools[name] : null;
      if (!tool) return { ok: false, text: 'unknown tool ' + JSON.stringify(name) + '; the tools are ' + API_TOOL_NAMES.join(', '), meta: { unknown: true } };
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, text: 'the arguments must be a JSON object', meta: {} };
      try { return await tool(args, options); }
      catch (error) {
        if (error instanceof Refusal) return { ok: false, refused: true, text: 'refused: ' + error.message, meta: {} };
        return { ok: false, text: 'error: ' + (error.code ? error.code + ' ' : '') + String(error.message ?? error).replaceAll(root, '.'), meta: {} };
      }
    },
  };
}
