import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import type { ServerOptions } from 'node:https';
import { generate } from 'selfsigned';

import { env } from './env';

export type HttpsSource = 'certificate' | 'development' | 'proxy' | 'test';

export type HttpsConfiguration = {
  options: ServerOptions | null;
  source: HttpsSource;
};

function localNames() {
  const siteHostname = new URL(env.SITE_URL).hostname;
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address);
  return [...new Set(['localhost', hostname(), '127.0.0.1', '::1', siteHostname, ...addresses])].sort();
}

function generateDevelopmentCertificate(): ServerOptions {
  const directory = path.resolve(process.cwd(), env.HTTPS_DEV_CERT_DIR);
  const keyFile = path.join(directory, 'wyre-dev-key.pem');
  const certificateFile = path.join(directory, 'wyre-dev-cert.pem');
  const metadataFile = path.join(directory, 'wyre-dev-cert.json');
  const names = localNames();
  let storedNames: string[] = [];

  if (existsSync(metadataFile)) {
    try {
      storedNames = JSON.parse(readFileSync(metadataFile, 'utf8')).names ?? [];
    } catch {
      storedNames = [];
    }
  }

  const certificateIsCurrent =
    existsSync(keyFile) &&
    existsSync(certificateFile) &&
    names.every((name) => storedNames.includes(name));

  if (!certificateIsCurrent) {
    mkdirSync(directory, { recursive: true });
    const altNames = names.map((name) =>
      isIP(name)
        ? { type: 7, ip: name }
        : { type: 2, value: name },
    );
    const certificate = generate(
      [{ name: 'commonName', value: new URL(env.SITE_URL).hostname }],
      {
        algorithm: 'sha256',
        days: 825,
        keySize: 2048,
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames },
        ],
      },
    );
    writeFileSync(keyFile, certificate.private, { mode: 0o600 });
    writeFileSync(certificateFile, certificate.cert, { mode: 0o644 });
    writeFileSync(metadataFile, `${JSON.stringify({ names }, null, 2)}\n`, { mode: 0o600 });
    console.warn(`Создан локальный сертификат HTTPS: ${certificateFile}`);
    console.warn('Он самоподписанный: добавьте сертификат в доверенные на устройствах разработки.');
  }

  return {
    key: readFileSync(keyFile),
    cert: readFileSync(certificateFile),
  };
}

export function resolveHttpsConfiguration(): HttpsConfiguration {
  if (env.HTTPS_KEY_FILE && env.HTTPS_CERT_FILE) {
    return {
      options: {
        key: readFileSync(path.resolve(process.cwd(), env.HTTPS_KEY_FILE)),
        cert: readFileSync(path.resolve(process.cwd(), env.HTTPS_CERT_FILE)),
      },
      source: 'certificate',
    };
  }

  if (env.NODE_ENV === 'development') {
    return { options: generateDevelopmentCertificate(), source: 'development' };
  }

  if (env.NODE_ENV === 'production') {
    return { options: null, source: 'proxy' };
  }

  return { options: null, source: 'test' };
}
