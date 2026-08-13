import fs from 'fs';
import path from 'path';
import selfsigned from 'selfsigned';

const CERT_DIR = path.join(process.cwd(), 'auth_info', 'tls');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

export async function getOrCreateSelfSignedCert(): Promise<{ key: string; cert: string }> {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return { key: fs.readFileSync(KEY_PATH, 'utf8'), cert: fs.readFileSync(CERT_PATH, 'utf8') };
  }

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);

  return { key: pems.private, cert: pems.cert };
}
