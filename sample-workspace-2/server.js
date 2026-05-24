// Second sample target — distinct from sample-workspace's app.js so
// when both are open in different VS Code windows you can clearly see
// the AI bind to the right workspace before driving the right program.

const http = require('http');

let requestCount = 0;

function handleRequest(req, res) {
  requestCount++;
  const payload = {
    requestNumber: requestCount,
    path: req.url,
    receivedAt: new Date().toISOString()
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
  console.log(`[${requestCount}] ${req.method} ${req.url}`);
}

const port = Number(process.env.PORT ?? 7100);
const server = http.createServer(handleRequest);
server.listen(port, '127.0.0.1', () => {
  console.log(`Sample server #2 listening on http://127.0.0.1:${port}`);
});
