/**
 * Development server for using SMA from phones on the same Wi-Fi. It serves the Next.js app
 * and forwards, on the same port (3000), what Next.js cannot:
 *   - the live connection (WebSocket upgrades on /socket.io/) to the API, and
 *   - photo/file transfers (/<bucket>/…) to the object storage, keeping the Host header so the
 *     presigned signature still matches.
 * Phones then only need port 3000, which Windows Firewall already allows.
 *
 * HTTPS: after `npm run lan:cert -w @storeline/web` the same port also speaks https (the first
 * byte of each connection tells which), so phones can use https://<this computer's IP>:3000.
 * Browsers only allow notifications, push and service workers on secure addresses. The phone
 * must trust the local certificate authority once; it is offered at /sma-local-ca.crt.
 *
 *   npm run start:lan -w @storeline/web      (after `npm run build -w @storeline/web`)
 *
 * Production uses a real reverse proxy instead (docs/operations/deployment.md).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';

const port = Number(process.env.PORT ?? 3000);
const api = new URL(process.env.API_ORIGIN ?? 'http://127.0.0.1:4000');
const storage = new URL(process.env.STORAGE_ORIGIN ?? 'http://127.0.0.1:18333');
const bucketPrefix = `/${process.env.S3_BUCKET ?? 'storeline-media'}/`;
const certs = join(dirname(fileURLToPath(import.meta.url)), '.certs');
const tls = existsSync(join(certs, 'lan.crt')) && existsSync(join(certs, 'lan.key'));

const app = next({ dev: false });
const handle = app.getRequestHandler();
await app.prepare();

const listener = (req, res) => {
  if (req.url === '/sma-local-ca.crt' && existsSync(join(certs, 'sma-local-ca.crt'))) {
    // Only the public certificate; the CA key never leaves the .certs folder.
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="sma-local-ca.crt"',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(join(certs, 'sma-local-ca.crt')));
    return;
  }
  if (req.url?.startsWith(bucketPrefix)) {
    // Raw pass-through: same method, path, query and headers (including Host).
    const upstream = request(
      {
        hostname: storage.hostname,
        port: storage.port || 80,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    return;
  }
  void handle(req, res);
};

const onUpgrade = (req, socket, head) => {
  if (!req.url?.startsWith('/socket.io/')) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(Number(api.port || 80), api.hostname, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(`${raw}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
};

const httpServer = createServer(listener).on('upgrade', onUpgrade);
const httpsServer = tls
  ? createHttpsServer(
      { key: readFileSync(join(certs, 'lan.key')), cert: readFileSync(join(certs, 'lan.crt')) },
      listener,
    ).on('upgrade', onUpgrade)
  : null;

// One port, both protocols: a TLS handshake always starts with byte 0x16.
const server = net.createServer((socket) => {
  socket.on('error', () => socket.destroy());
  socket.once('data', (first) => {
    socket.pause();
    socket.unshift(first);
    (httpsServer && first[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
});

server.listen(port, () => {
  process.stdout.write(
    `SMA web on http://localhost:${port} (also reachable from the local network)\n` +
      (tls
        ? `HTTPS on the same port: https://<this computer's IP>:${port} (certificate at /sma-local-ca.crt)\n`
        : 'No HTTPS certificate yet: run "npm run lan:cert -w @storeline/web" for phone notifications.\n'),
  );
});
