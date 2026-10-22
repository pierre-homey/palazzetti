'use strict';
const http = require('http');

// An absolute deadline also covers responses that keep trickling in forever.
module.exports = function request(url, options = {}) {
  const timeout = options.timeout || 15000;
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let req;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const fail = error => {
      finish(error);
      if (req) req.destroy();
    };
    const cancel = () => fail(new Error('CBox request cancelled'));
    try {
      req = http.get(url, response => {
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`CBox HTTP ${response.statusCode}`));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 1024 * 1024) fail(new Error('CBox response too large'));
        });
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('CBox response aborted')));
        response.on('end', () => {
          if (settled) return;
          try {
            const result = JSON.parse(body);
            if (!result || ![true, 1, '1'].includes(result.SUCCESS)) {
              throw new Error('CBox command failed');
            }
            finish(null, result.DATA);
          } catch (error) {
            fail(error);
          }
        });
      });
      req.on('error', fail);
      timer = setTimeout(() => fail(new Error('CBox request timed out')), timeout);
      if (typeof options.onRequest === 'function') options.onRequest(cancel);
    } catch (error) {
      fail(error);
    }
  });
};
