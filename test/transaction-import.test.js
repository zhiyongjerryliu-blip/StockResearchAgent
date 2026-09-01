import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { openDatabase } from '../src/db.js';
import { addTransaction, upsertWatchlistItem } from '../src/repository.js';
import { commitTransactionImport, validateTransactionImport } from '../src/transaction-import.js';

const headers = ['交易日期', '股票代码', '股票名称', '交易方向', '股数', '成交价', '交易费用', '备注'];

async function workbookPayload(rows, fileName = '交易.xlsx') {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('交易导入');
  worksheet.addRow(headers);
  for (const row of rows) worksheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return { fileName, dataBase64: Buffer.from(buffer).toString('base64') };
}

test('有效Excel预检后原子导入，并将未知股票自动加入股票池', async () => {
  const db = openDatabase(':memory:');
  const payload = await workbookPayload([
    [new Date(Date.UTC(2026, 7, 3)), 'testx', 'Test Corporation', '买入', 10, 20, 1, '首笔建仓'],
    ['2026-08-04', 'TESTX', 'Test Corporation', 'SELL', 4, 25, 0.5, '部分卖出']
  ]);

  const validation = await validateTransactionImport(db, payload);
  assert.equal(validation.valid, true);
  assert.equal(validation.rowCount, 2);
  assert.deepEqual(validation.addedStocks, [{ ticker: 'TESTX', name: 'Test Corporation' }]);
  assert.ok(validation.token);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 0);

  const result = commitTransactionImport(db, validation.token);
  assert.equal(result.imported, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 2);
  assert.equal(db.prepare('SELECT name FROM securities WHERE ticker = ?').get('TESTX').name, 'Test Corporation');
  assert.equal(db.prepare('SELECT enabled FROM watchlist_items WHERE ticker = ?').get('TESTX').enabled, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transaction_import_batches').get().count, 1);
  assert.equal(db.prepare('SELECT trade_time FROM transactions ORDER BY id LIMIT 1').get().trade_time, '2026-08-03T16:00:00.000Z');

  const duplicate = await validateTransactionImport(db, payload);
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors[0].message, /已经成功导入/);
  db.close();
});

test('预检会拦截超卖，且不会写入任何股票或交易', async () => {
  const db = openDatabase(':memory:');
  const payload = await workbookPayload([
    ['2026-08-03', 'NEWCO', 'New Company', '卖出', 2, 50, 0, '无持仓卖出']
  ], '超卖.xlsx');

  const validation = await validateTransactionImport(db, payload);
  assert.equal(validation.valid, false);
  assert.equal(validation.token, null);
  assert.match(validation.errors[0].message, /卖出股数超过可用持仓/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM securities').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 0);
  db.close();
});

test('预检会报告格式错误和文件内完全重复的交易', async () => {
  const db = openDatabase(':memory:');
  const duplicateRow = ['2026-08-03', 'NVDA', 'NVIDIA', 'BUY', 1, 100, 0, '测试'];
  const payload = await workbookPayload([
    duplicateRow,
    duplicateRow,
    ['2026/08/04', 'NVDA', 'NVIDIA', 'BUY', 1, 100, 0, '错误日期']
  ], '错误数据.xlsx');

  const validation = await validateTransactionImport(db, payload);
  assert.equal(validation.valid, false);
  assert.equal(validation.rowCount, 3);
  assert.ok(validation.errors.some((error) => /完全重复/.test(error.message)));
  assert.ok(validation.errors.some((error) => /YYYY-MM-DD/.test(error.message)));
  db.close();
});

test('CSV文件可通过同一套预检与导入流程', async () => {
  const db = openDatabase(':memory:');
  const csv = [
    `\uFEFF${headers.join(',')}`,
    '2026-08-05,AAPL,Apple Inc.,BUY,2,210.5,0.25,CSV导入'
  ].join('\n');
  const validation = await validateTransactionImport(db, {
    fileName: '交易.csv',
    dataBase64: Buffer.from(csv, 'utf8').toString('base64')
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.rows[0].tradeDate, '2026-08-05');
  const result = commitTransactionImport(db, validation.token);
  assert.equal(result.imported, 1);
  assert.equal(db.prepare('SELECT ticker FROM transactions').get().ticker, 'AAPL');
  db.close();
});

test('单笔录入只接收日期并保存为稳定的美股交易日期', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'MSFT', name: 'Microsoft' });
  const transaction = addTransaction(db, {
    ticker: 'MSFT', side: 'BUY', tradeDate: '2026-08-06', quantity: 3, price: 500, fee: 0
  });

  assert.equal(transaction.trade_time, '2026-08-06T16:00:00.000Z');
  assert.throws(() => addTransaction(db, {
    ticker: 'MSFT', side: 'BUY', tradeDate: '2026-02-30', quantity: 1, price: 1, fee: 0
  }), /交易日期无效/);
  db.close();
});
