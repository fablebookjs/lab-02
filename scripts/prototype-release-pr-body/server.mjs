// PROTOTYPE — throwaway preview for the maintainer-facing release PR body.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const page = await readFile(join(directory, 'index.html'));
const template = await readFile(join(directory, 'release-pr-template.md'));
const port = Number.parseInt(process.env.PROTOTYPE_PORT ?? '4173', 10);

createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
  if (path === '/prototype/release-pr-body/template') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(template);
    return;
  }
  if (path !== '/' && path !== '/prototype/release-pr-body') {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(page);
}).listen(port, '127.0.0.1', () => {
  console.log(`Release PR body prototype: http://127.0.0.1:${port}/prototype/release-pr-body`);
});
