/**
 * Makes a local HTTPS certificate so phones on the same Wi-Fi get a secure address
 * (https://<this computer's IP>:3000), which browsers require for notifications, push,
 * the clipboard and service workers.
 *
 *   npm run lan:cert -w @storeline/web
 *
 * Creates, in apps/web/.certs/ (git-ignored):
 *   - sma-local-ca.crt / .key  a private certificate authority, made once and kept. Install the
 *                              .crt on each phone once (the LAN server offers it for download at
 *                              /sma-local-ca.crt). Never share the .key.
 *   - lan.crt / lan.key        the server certificate for localhost and this computer's current
 *                              Wi-Fi/LAN addresses. Re-run this script if the IP address changes;
 *                              phones do not need to reinstall anything.
 *
 * Development only. Production uses a real certificate on the reverse proxy.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.certs');
mkdirSync(dir, { recursive: true });
const at = (name) => join(dir, name).replace(/\\/g, '/');

function findOpenssl() {
  const candidates = [
    process.env.OPENSSL,
    'openssl',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // Try the next one.
    }
  }
  throw new Error('OpenSSL not found. Install Git for Windows or set OPENSSL to its path.');
}
const openssl = findOpenssl();
const run = (...args) => execFileSync(openssl, args, { stdio: ['ignore', 'ignore', 'inherit'] });

// Private IPv4 addresses of this computer (Wi-Fi, Ethernet).
const ips = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address)
  .filter((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
  // Home/office Wi-Fi first; 172.x is usually a virtual adapter (WSL, Docker, Hyper-V).
  .sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));

// 1. The certificate authority (kept between runs so phones only install it once).
if (!existsSync(at('sma-local-ca.crt')) || !existsSync(at('sma-local-ca.key'))) {
  writeFileSync(
    at('ca.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_ca',
      'prompt = no',
      '[dn]',
      'CN = SMA Local Development CA',
      'O = SMA Technology (development)',
      '[v3_ca]',
      'basicConstraints = critical, CA:TRUE, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  );
  run(
    'req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1825',
    '-keyout', at('sma-local-ca.key'), '-out', at('sma-local-ca.crt'), '-config', at('ca.cnf'),
  );
  process.stdout.write('Created a new local certificate authority (install it on each phone once).\n');
}

// 2. The server certificate (397 days: the longest browsers accept).
const names = ['DNS.1 = localhost', 'IP.1 = 127.0.0.1', ...ips.map((ip, i) => `IP.${i + 2} = ${ip}`)];
writeFileSync(
  at('lan.cnf'),
  [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'CN = SMA local network',
    '[ext]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @names',
    'authorityKeyIdentifier = keyid',
    '[names]',
    ...names,
    '',
  ].join('\n'),
);
run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('lan.key'), '-out', at('lan.csr'), '-config', at('lan.cnf'));
run(
  'x509', '-req', '-in', at('lan.csr'), '-CA', at('sma-local-ca.crt'), '-CAkey', at('sma-local-ca.key'),
  '-CAcreateserial', '-out', at('lan.crt'), '-days', '397', '-sha256',
  '-extfile', at('lan.cnf'), '-extensions', 'ext',
);

process.stdout.write(
  `Certificate ready for: localhost${ips.map((ip) => `, ${ip}`).join('')}\n` +
    `Restart the LAN server, then open https://${ips[0] ?? 'localhost'}:3000 on the phone.\n`,
);
