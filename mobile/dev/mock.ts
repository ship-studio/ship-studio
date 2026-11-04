/**
 * Run the mock Mac:
 *
 *   pnpm mock                      # https://localhost:47443, self-signed
 *   pnpm mock --http --port 47450  # plain HTTP, e.g. behind `tailscale serve --https=47443`
 *   pnpm mock --public-url https://mac.tailnet.ts.net:47443
 */

/* eslint-disable no-console -- a CLI prints to stdout */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createMockServer } from './mock-server';

function selfSigned(dir: string) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      // RSA: the iOS Simulator's keychain refuses an EC root.
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '825',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ]);
  }
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

{
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const plain = args.includes('--http');
  const tls = plain ? undefined : selfSigned(path.resolve(__dirname, '.certs'));
  const mock = createMockServer({
    port: Number(arg('--port') ?? (plain ? 47450 : 47443)),
    publicUrl: arg('--public-url'),
    devicesFile: path.resolve(__dirname, '.certs', 'devices.json'),
    ...(tls ? { tls: { key: tls.key, cert: tls.cert } } : {}),
  });
  void mock.listen().then((url) => {
    const link = mock.pairingLink();
    console.log(`\nShip Studio mock Mac on ${url}\n`);
    if (tls) {
      console.log('Simulator, once per simulator (trust the self-signed certificate):');
      console.log(`  xcrun simctl keychain booted add-root-cert ${tls.certPath}\n`);
    }
    console.log('Pair the booted simulator:');
    console.log(`  xcrun simctl openurl booted '${link}'\n`);
    console.log(`Pairing link (one use; a fresh one: curl -sk ${url}/dev/link):\n  ${link}\n`);
  });
}
