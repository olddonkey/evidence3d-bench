import http from 'node:http';
import https from 'node:https';

// One JSON POST over node:http(s). Not fetch: Node's fetch (undici) gives up
// on a response whose headers take more than 300 s, and a non-streaming
// request to a reasoning model can take longer than that. The socket gets a
// TCP keep-alive (as the Claude API docs advise for long requests) and an
// idle timeout of `timeoutMs`.
// Resolves { status, headers, text, json } for any HTTP response; rejects
// with an error carrying `network: true` (and the system error code) when no
// complete response arrived: DNS, refused or reset connection, TLS, timeout,
// a connection dropped mid-body.
export function postJSON(url, { headers = {}, body, timeoutMs = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { reject(Object.assign(new Error('invalid URL ' + url), { network: false })); return; }
    const payload = Buffer.from(JSON.stringify(body));
    const client = target.protocol === 'https:' ? https : http;
    const fail = (error, code = error?.code) => reject(Object.assign(new Error(String(error?.message ?? error)), { network: true, code: code ?? null }));
    const request = client.request(target, { method: 'POST', agent: false,
      headers: { ...headers, 'content-length': payload.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('aborted', () => fail(new Error('the connection was closed before the response was complete'), 'ECONNRESET'));
      response.on('error', error => fail(error));
      response.on('end', () => {
        if (!response.complete) { fail(new Error('the connection was closed before the response was complete'), 'ECONNRESET'); return; }
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('socket', socket => socket.setKeepAlive(true, 30000));
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('no response within ' + Math.round(timeoutMs / 1000) + ' s'), { code: 'ETIMEDOUT' })));
    request.on('error', error => fail(error));
    request.end(payload);
  });
}

// ---------------------------------------------------------------- redaction

// The API key reaches the loop on stdin and is held in memory only. Every
// line the loop writes (events, stderr) and every message the runner records
// passes through this: the key itself, and anything that looks like an
// authorization header value, become [REDACTED].
const HEADER_VALUE = /\b(authorization|x-api-key|api[_-]?key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi;
const KEY_SHAPED = /\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,})\b/g;

export function redactor(...secrets) {
  const keys = secrets.filter(secret => typeof secret === 'string' && secret.length >= 8);
  return value => {
    let text = String(value ?? '');
    for (const key of keys) text = text.split(key).join('[REDACTED]');
    return text.replace(HEADER_VALUE, (match, name, sep, bearer) => name + sep + (bearer ?? '') + '[REDACTED]').replace(KEY_SHAPED, '[REDACTED]');
  };
}
