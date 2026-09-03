// Tiny static file server for headless smoke testing (no deps).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8973;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + file);
  }
}).listen(port, () => console.log('server on http://127.0.0.1:' + port));
