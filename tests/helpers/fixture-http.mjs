/**
 * The HTTP server the leak probes' fixtures use, as a separate process.
 *
 * It has to be out of process: the pre-#65 code fetched with `execFileSync`,
 * which blocks the event loop, so an in-process server could never answer it —
 * every fetch would just time out and the comparison with the old code would
 * measure nothing.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [root, portFile] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
  fs.readFile(path.join(root, rel), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
