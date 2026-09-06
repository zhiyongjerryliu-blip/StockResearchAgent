import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serviceScript = readFileSync(new URL('../scripts/service.js', import.meta.url), 'utf8');

test('macOS常驻服务对任何未卸载退出保持自动拉起', () => {
  assert.match(serviceScript, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(serviceScript, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(serviceScript, /launchctl\(\['bootout', serviceTarget\]\)/);
});
