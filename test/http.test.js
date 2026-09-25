'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('../lib/cbox-http');
function serve(t, handler, run) {
  const server = http.createServer(handler);
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    .then(() => run(`http://127.0.0.1:${server.address().port}/`));
}
test('HTTP accepts successful JSON including split chunks', t => serve(t, (req, res) => {
  res.write('{"SUCCESS":true,');
  res.end('"DATA":{"STATUS":0}}');
}, url => request(url).then(data => assert.deepEqual(data, { STATUS: 0 }))));
for (const [name, status, body] of [
  ['HTTP error', 500, '{"SUCCESS":true}'],
  ['malformed JSON', 200, '{'],
  ['CBox rejection', 200, '{"SUCCESS":false}'],
  ['string false is not success', 200, '{"SUCCESS":"false"}'],
]) {
  test(name, t => serve(t, (req, res) => { res.statusCode = status; res.end(body); },
    url => assert.rejects(request(url))));
}
test('silent CBox hits deadline', t => serve(t, () => {},
  url => assert.rejects(request(url, { timeout: 40 }), /timed out/)));
test('truncated response rejects', t => serve(t, (req, res) => {
  res.write('{"SUCCESS":');
  setImmediate(() => res.destroy());
}, url => assert.rejects(request(url), /aborted|reset|hang up/)));
test('oversize response rejects', t => serve(t, (req, res) => res.end('x'.repeat(1024 * 1024 + 1)),
  url => assert.rejects(request(url), /too large/)));

test('absolute deadline interrupts continuously arriving data', t => serve(t, (req, res) => {
  res.write('{');
  const interval = setInterval(() => res.write(' '), 5);
  res.on('close', () => clearInterval(interval));
}, url => assert.rejects(request(url, { timeout: 40 }), /timed out/)));
