import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local server for the rating page. It binds 127.0.0.1 only, serves the page
// from v1/lib/study/page/ and, from the study directory, pairs.json and the
// images that pairs.json names (nothing else: key.json is never reachable),
// and appends votes to votes.jsonl.
//
//   GET  /            the page            GET /pairs.json   the public pair list
//   GET  /images/<f>  a rendered image    GET /votes        { votes: [...] } so the page resumes
//   POST /vote        { pair, choice: a|b|tie, ms, hidden_ms? } -> one line { pair, choice, ms, hidden_ms, at } in votes.jsonl
//
// ms is the time from showing the pair to the vote; hidden_ms the part of it
// the page was hidden. A revision is a new line; the analysis keeps the last
// vote per pair.

export const DEFAULT_PORT = 4173;
export const HOST = '127.0.0.1';
export const CHOICES = ['a', 'b', 'tie'];
// A vote's time on the pair is capped at a day; anything larger is a broken clock.
const MAX_MS = 24 * 3600 * 1000;
const MAX_BODY = 4096;
const PAGE_DIR = fileURLToPath(new URL('./page/', import.meta.url));
const PAGE_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/state.js': 'state.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

// votes.jsonl -> { votes, malformed }. A line that is not a valid vote (a torn
// write, a hand edit) is counted and skipped, never guessed at.
export function parseVotes(text) {
  const votes = [];
  let malformed = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let vote;
    try { vote = JSON.parse(line); } catch { malformed++; continue; }
    if (!vote || typeof vote.pair !== 'string' || !CHOICES.includes(vote.choice)) { malformed++; continue; }
    votes.push({ pair: vote.pair, choice: vote.choice, ms: Number.isFinite(vote.ms) ? vote.ms : null,
      hidden_ms: Number.isFinite(vote.hidden_ms) ? vote.hidden_ms : null, at: typeof vote.at === 'string' ? vote.at : null });
  }
  return { votes, malformed };
}

export async function readVotes(studyDir) {
  try { return parseVotes(await readFile(join(studyDir, 'votes.jsonl'), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { votes: [], malformed: 0 };
    throw error;
  }
}

// Validates a posted vote against the study's pair ids; returns the line to store or throws.
export function voteLine(payload, pairIds, at) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('vote must be a JSON object');
  if (typeof payload.pair !== 'string' || !pairIds.has(payload.pair)) throw new Error('unknown pair');
  if (!CHOICES.includes(payload.choice)) throw new Error('choice must be one of ' + CHOICES.join(', '));
  if (!Number.isFinite(payload.ms) || payload.ms < 0 || payload.ms > MAX_MS) throw new Error('ms must be a number of milliseconds between 0 and ' + MAX_MS);
  const hidden = payload.hidden_ms ?? null;
  if (hidden !== null && (!Number.isFinite(hidden) || hidden < 0 || hidden > payload.ms)) throw new Error('hidden_ms must be between 0 and ms');
  return { pair: payload.pair, choice: payload.choice, ms: Math.round(payload.ms), hidden_ms: hidden === null ? null : Math.round(hidden), at };
}

async function body(request) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('expected application/json');
  let bytes = 0, text = '';
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('request body too large');
    text += chunk;
  }
  return JSON.parse(text);
}

export async function startStudyServer({ studyDir, port = DEFAULT_PORT, now = () => new Date() }) {
  const pairsBytes = await readFile(join(studyDir, 'pairs.json'));
  const study = JSON.parse(pairsBytes.toString('utf8'));
  const pairIds = new Set(study.pairs.map(pair => pair.id));
  // Only the images pairs.json names can be fetched, so no path from a request reaches the file system.
  const imageNames = new Set(study.pairs.flatMap(pair => Object.values(pair.images).flatMap(byRole => Object.values(byRole))));
  const votesFile = join(studyDir, 'votes.jsonl');
  let appending = Promise.resolve();

  const send = (response, status, bytes, type, cache = 'no-store') => {
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': cache });
    response.end(bytes);
  };
  const json = (response, status, value) => send(response, status, Buffer.from(JSON.stringify(value)), TYPES['.json']);

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    try {
      const own = server.address().port;
      // A page on another site cannot reach this server through DNS rebinding:
      // only requests addressed to this host and port are answered.
      if (![HOST + ':' + own, 'localhost:' + own].includes(request.headers.host)) return json(response, 403, { error: 'local host required' });
      const path = new URL(request.url, 'http://' + request.headers.host).pathname;
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && origin !== 'http://' + request.headers.host) return json(response, 403, { error: 'cross-origin writes are not allowed' });
        if (path !== '/vote') return json(response, 404, { error: 'not found' });
        const line = voteLine(await body(request), pairIds, now().toISOString());
        const write = appending.then(() => appendFile(votesFile, JSON.stringify(line) + '\n'));
        appending = write.catch(() => {});
        await write;
        return json(response, 200, { ok: true, vote: line });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method not allowed' });
      if (path === '/pairs.json') return send(response, 200, pairsBytes, TYPES['.json']);
      if (path === '/votes') {
        const { votes, malformed } = await readVotes(studyDir);
        return json(response, 200, { votes, malformed });
      }
      if (PAGE_FILES[path]) {
        const file = PAGE_FILES[path];
        return send(response, 200, await readFile(join(PAGE_DIR, file)), TYPES[extname(file)]);
      }
      const image = path.match(/^\/images\/([^/]+)$/);
      if (image && imageNames.has(image[1])) return send(response, 200, await readFile(join(studyDir, 'images', image[1])), TYPES['.png'], 'private, max-age=3600');
      return json(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) json(response, error.code === 'ENOENT' ? 404 : 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error('port ' + port + ' on ' + HOST + ' is in use; choose another with --port') : error));
    server.listen(port, HOST, resolve);
  });
  const address = server.address();
  return {
    server, url: 'http://' + HOST + ':' + address.port + '/', address,
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
