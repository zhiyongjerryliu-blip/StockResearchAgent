import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('个股综合研报九章都有默认可读渲染分支', () => {
  for (const key of ['summary', 'operations', 'expectations', 'earnings', 'valuation', 'market', 'risks', 'forecast', 'methodology']) {
    assert.match(appSource, new RegExp(`section\\.key === '${key}'`));
  }
  assert.match(appSource, /researchAuditDetails\(data\)/);
});

test('研报导出入口显示PDF且不再显示HTML导出', () => {
  assert.match(pageSource, /id="export-research-report"[^>]*>导出PDF</);
  assert.doesNotMatch(pageSource, /导出HTML/);
});
