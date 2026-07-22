import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

test('release QA issue creation is query-first and retryable', async () => {
  const requests = [];
  let issue = null;
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) {
      body.push(chunk);
    }
    const text = Buffer.concat(body).toString('utf8');
    requests.push({ method: request.method, path: request.url, text });
    response.setHeader('content-type', 'application/json');

    if (request.method === 'GET' && request.url.startsWith('/repos/fablebookjs/lab-02/issues?')) {
      response.end(JSON.stringify(issue === null ? [] : [issue]));
      return;
    }
    if (request.method === 'POST' && request.url === '/repos/fablebookjs/lab-02/issues') {
      const input = JSON.parse(text);
      issue = {
        body: input.body,
        html_url: 'https://github.com/fablebookjs/lab-02/issues/41',
        number: 41,
        state: 'open',
      };
      response.statusCode = 201;
      response.end(JSON.stringify(issue));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    process.env.GITHUB_API_URL = `http://127.0.0.1:${address.port}`;
    const { ensureReleaseQaIssue } = await import('../scripts/release-proposal-github.mjs');
    const input = {
      identity: `proposal:${'a'.repeat(40)}`,
      line: 'v1.0',
      version: '1.0.0',
    };

    assert.deepEqual(await ensureReleaseQaIssue('test-token', input), {
      number: 41,
      url: 'https://github.com/fablebookjs/lab-02/issues/41',
    });
    assert.deepEqual(await ensureReleaseQaIssue('test-token', input), {
      number: 41,
      url: 'https://github.com/fablebookjs/lab-02/issues/41',
    });
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
    assert.match(
      requests.find(({ method }) => method === 'POST').text,
      /fablebook:release-qa=v1 identity=proposal:a{40}/
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    delete process.env.GITHUB_API_URL;
  }
});
