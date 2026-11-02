import assert from 'node:assert/strict';
import test from 'node:test';

// config.js 在加载时读取 ALLOWED_HOSTS，要在导入前设置（node --test 每个文件单独一个进程）
process.env.ALLOWED_HOSTS = 'localhost, 127.0.0.1 ,38.97.249.132';
const { hostFromHeader, isAllowedHostHeader } = await import('../src/config.js');

test('hostFromHeader strips the port and IPv6 brackets', () => {
  assert.equal(hostFromHeader('38.97.249.132:8787'), '38.97.249.132');
  assert.equal(hostFromHeader('[::1]:8787'), '::1');
  assert.equal(hostFromHeader('LocalHost'), 'localhost');
  assert.equal(hostFromHeader(undefined), '');
});

test('ALLOWED_HOSTS entries match the Host header with or without a port', () => {
  assert.equal(isAllowedHostHeader('38.97.249.132:8787'), true);
  assert.equal(isAllowedHostHeader('38.97.249.132'), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:8787'), true);
  assert.equal(isAllowedHostHeader('evil.example.com:8787'), false);
  assert.equal(isAllowedHostHeader('[::1]:8787'), false);
  assert.equal(isAllowedHostHeader(''), false);
  assert.equal(isAllowedHostHeader(undefined), false);
});
