import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const javascript = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('主题选择器提供跟随系统、浅色和深色三种模式', () => {
  assert.match(html, /id="theme-select"/);
  assert.match(html, /option value="system">跟随系统/);
  assert.match(html, /option value="light">浅色/);
  assert.match(html, /option value="dark">深色/);
});

test('主题在页面绘制前恢复并在切换后保存', () => {
  assert.match(html, /localStorage\.getItem\('stockresearchagent\.theme'\)/);
  assert.match(html, /document\.documentElement\.dataset\.theme/);
  assert.match(javascript, /localStorage\.setItem\(THEME_STORAGE_KEY, selected\)/);
  assert.match(javascript, /addEventListener\('change'/);
});

test('浅色主题和跟随系统模式均定义完整样式入口', () => {
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.match(css, /:root\[data-theme="system"\]/);
  assert.match(css, /color-scheme: light/);
  assert.match(css, /color-scheme: dark/);
});

test('浅色主题使用与富途一致的高饱和红绿盈亏配色', () => {
  const lightTheme = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  const profit = lightTheme.match(/--profit:\s*(#[0-9a-f]{6})/i)?.[1];
  const loss = lightTheme.match(/--loss:\s*(#[0-9a-f]{6})/i)?.[1];

  assert.ok(profit);
  assert.ok(loss);
  assert.equal(profit.toLowerCase(), '#f05068');
  assert.equal(loss.toLowerCase(), '#00b080');
  assert.doesNotMatch(css, /\.positive::before/);
  assert.doesNotMatch(css, /\.negative::before/);
});
