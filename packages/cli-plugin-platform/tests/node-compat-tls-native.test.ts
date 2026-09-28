import { expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DEPS } from '../src/deps';
import { renderWorldWit, runtimeRequirementsFromJavaScript } from '../src/wit';

// Opt-in: requires componentize-qjs, Wasmtime 48 with TLS/P3, openssl and Internet access.
// No WASI mocks: validates the compiled QuickJS component against real host encryption.
it.skipIf(process.env.DI_WASI_TLS_SMOKE !== '1')(
  'runs TLS and HTTPS in Wasmtime and rejects untrusted certificates and wrong names',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'di-native-tls-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    async function command(args: string[]): Promise<string> {
      const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}\n${stdout}`);
      return stdout;
    }
    try {
      const adapterPath = join(root, 'adapter.ts');
      const entryPath = join(root, 'entry.ts');
      const outFile = join(root, 'bundle.js');
      writeFileSync(
        adapterPath,
        "export { default as run } from 'virtual:di-framework-application';",
      );
      writeFileSync(
        entryPath,
        `
import { get } from 'node:https';
import { connect } from 'node:tls';
export default async function run(mode, destination, servername) {
  try {
    return await new Promise((resolve, reject) => {
      if (mode === 'tls') {
        const url = new URL(destination);
        const socket = connect({host: url.hostname, port: Number(url.port || 443), servername}, () => {
          socket.write('GET / HTTP/1.1\\r\\nHost: ' + url.hostname + '\\r\\nConnection: close\\r\\n\\r\\n');
        });
        let body = '';
        socket.on('data', data => { body += Buffer.from(data).toString(); });
        socket.on('end', () => resolve('TLS:' + socket.authorized + ':' + body.includes('Example Domain')));
        socket.on('error', reject);
        socket.setTimeout(10000, () => socket.destroy(new Error('timeout')));
      } else {
        const req = get(destination, {servername, headers: {connection: 'close'}, timeout: 10000}, res => {
          let body = '';
          res.on('data', data => { body += Buffer.from(data).toString(); });
          res.on('end', () => resolve('HTTPS:' + res.statusCode + ':' + body.includes('Example Domain')));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
      }
    });
  } catch (error) { return 'ERROR:' + error.message; }
}
`,
      );
      await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
      const wit = join(root, 'wit');
      mkdirSync(wit);
      cpSync(join(import.meta.dir, '../assets/wit/deps'), join(wit, 'deps'), { recursive: true });
      const requirements = runtimeRequirementsFromJavaScript(readFileSync(outFile, 'utf8'));
      writeFileSync(
        join(wit, 'world.wit'),
        renderWorldWit('tls-smoke', '1.0.0', requirements).replace(
          '\n}',
          '\n  export run: async func(mode: string, destination: string, servername: string) -> string;\n}',
        ),
      );
      const compiler = DEFAULT_DEPS.componentizeQjsPath();
      if (!compiler) throw new Error('componentize-qjs is required');
      const wasm = join(root, 'component.wasm');
      await command([compiler, '--wit', wit, '--js', outFile, '-n', 'application', '-o', wasm]);
      async function run(mode: string, destination: string, servername: string): Promise<string> {
        return command([
          'wasmtime',
          'run',
          '-S',
          'p3=y,tls=y,inherit-network=y,allow-ip-name-lookup=y',
          '--invoke',
          `run(${[mode, destination, servername].map((value) => JSON.stringify(value)).join(',')})`,
          wasm,
        ]);
      }
      expect(await run('https', 'https://example.com', 'example.com')).toContain('HTTPS:200:true');
      expect(await run('tls', 'https://example.com', 'example.com')).toContain('TLS:true:true');
      const mismatch = await run('https', 'https://example.com', 'mismatch.invalid');
      expect(mismatch).toContain('ERROR:');
      // The public endpoint can reject unknown SNI before sending a certificate.
      expect(mismatch.toLowerCase()).toMatch(/certificate|handshakefailure/);

      const key = join(root, 'key.pem');
      const cert = join(root, 'cert.pem');
      await command([
        'openssl',
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
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ]);
      let requests = 0;
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { key: readFileSync(key), cert: readFileSync(cert) },
        fetch: () => {
          requests++;
          return new Response('must not be reached');
        },
      });
      const untrusted = await run('https', `https://127.0.0.1:${server.port}`, 'localhost');
      expect(untrusted).toContain('ERROR:');
      expect(untrusted.toLowerCase()).toContain('certificate');
      expect(requests).toBe(0);
    } finally {
      server?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
