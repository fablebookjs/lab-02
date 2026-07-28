// PROTOTYPE ONLY — a tiny static server for the composed migration-guide discussion.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const port = Number.parseInt(process.env.PROTOTYPE_PORT ?? '4173', 10);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const requested = join(root, pathname.replace(/^\/+/, ''));
  const candidate =
    pathname !== '/' && (await stat(requested).catch(() => null))?.isFile()
      ? requested
      : join(root, 'index.html');

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
  });
  createReadStream(candidate).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`Migration-guide prototype: http://127.0.0.1:${port}/?variant=A`);
});
