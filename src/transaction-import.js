import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { nowIso, toPlainRows } from './db.js';
import { normalizeTicker } from './domain.js';
import { calculatePosition } from './portfolio.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REQUIRED_HEADERS = ['交易日期', '股票代码', '股票名称', '交易方向', '股数', '成交价', '交易费用', '备注'];
const pendingImports = new Map();

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Object.hasOwn(value, 'formula')) throw new Error('不允许使用公式单元格');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (Object.hasOwn(value, 'text')) return String(value.text).trim();
    if (Object.hasOwn(value, 'result')) return value.result;
  }
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('必须使用YYYY-MM-DD格式');
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error('日期无效');
  return text;
}

function normalizeNumber(value, field, { positive = false } = {}) {
  if (value == null || value === '') {
    if (field === '交易费用') return 0;
    throw new Error(`${field}不能为空`);
  }
  const text = typeof value === 'string' ? value.replaceAll(',', '').trim() : value;
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`${field}必须是数字`);
  if (positive ? number <= 0 : number < 0) throw new Error(`${field}${positive ? '必须大于0' : '不能小于0'}`);
  return number;
}

function normalizeDirection(value) {
  const direction = String(value ?? '').trim().toUpperCase();
  if (direction === '买入') return 'BUY';
  if (direction === '卖出') return 'SELL';
  if (!['BUY', 'SELL'].includes(direction)) throw new Error('交易方向只能是BUY或SELL');
  return direction;
}

function findImportSheet(workbook) {
  const named = workbook.getWorksheet('交易导入');
  if (named) return named;
  return workbook.worksheets.find((sheet) => sheet.actualRowCount > 0) || null;
}

async function parseFile(buffer, extension) {
  const workbook = new ExcelJS.Workbook();
  // CSV中的日期必须保持用户输入的YYYY-MM-DD文本，避免解析为本地午夜后再转UTC造成跨日。
  if (extension === '.csv') await workbook.csv.read(Readable.from([buffer]), { dateFormats: [] });
  else await workbook.xlsx.load(buffer);
  const worksheet = findImportSheet(workbook);
  if (!worksheet) throw new Error('文件中没有可读取的工作表');

  let headerRowNumber = null;
  let headerMap = null;
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.actualRowCount || 10); rowNumber += 1) {
    const values = worksheet.getRow(rowNumber).values.slice(1).map(cellText);
    const candidate = new Map(values.map((value, index) => [String(value).trim().replace(/^\uFEFF/, ''), index + 1]));
    if (candidate.has('交易日期') && candidate.has('股票代码')) {
      headerRowNumber = rowNumber;
      headerMap = candidate;
      break;
    }
  }
  if (!headerMap) throw new Error('找不到模板表头，请使用系统提供的交易导入模板');
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headerMap.has(header));
  if (missingHeaders.length) throw new Error(`缺少列：${missingHeaders.join('、')}`);

  const rows = [];
  const rowErrors = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const raw = Object.fromEntries(REQUIRED_HEADERS.map((header) => [
      header,
      cellText(worksheet.getRow(rowNumber).getCell(headerMap.get(header)).value)
    ]));
    if (Object.values(raw).every((value) => value == null || value === '')) continue;
    if (rows.length >= MAX_IMPORT_ROWS) throw new Error(`单次最多导入${MAX_IMPORT_ROWS}行交易`);
    try {
      const tradeDate = normalizeDate(raw['交易日期']);
      const ticker = normalizeTicker(raw['股票代码']);
      const name = String(raw['股票名称'] ?? '').trim();
      const note = String(raw['备注'] ?? '').trim();
      if (name.length > 100) throw new Error('股票名称不能超过100个字符');
      if (note.length > 500) throw new Error('备注不能超过500个字符');
      rows.push({
        rowNumber,
        tradeDate,
        tradeTime: `${tradeDate}T16:00:00.000Z`,
        ticker,
        name: name || ticker,
        side: normalizeDirection(raw['交易方向']),
        quantity: normalizeNumber(raw['股数'], '股数', { positive: true }),
        price: normalizeNumber(raw['成交价'], '成交价'),
        fee: normalizeNumber(raw['交易费用'], '交易费用'),
        note: note || null
      });
    } catch (error) {
      rowErrors.push({ rowNumber, message: error.message });
    }
  }
  if (!rows.length && !rowErrors.length) throw new Error('交易导入表中没有交易数据');
  return { rows, rowErrors };
}

function exactRowKey(row) {
  return [row.tradeDate, row.ticker, row.side, row.quantity, row.price, row.fee, row.note || ''].join('|');
}

function portfolioErrors(db, rows) {
  const errors = [];
  const tickers = [...new Set(rows.map((row) => row.ticker))];
  for (const ticker of tickers) {
    const existing = toPlainRows(db.prepare(`
      SELECT id, side, trade_time, quantity FROM transactions WHERE ticker = ?
    `).all(ticker)).map((transaction) => ({ ...transaction, source: 'existing' }));
    const incoming = rows.filter((row) => row.ticker === ticker).map((row) => ({
      ...row,
      source: 'incoming'
    }));
    const combined = [...existing, ...incoming].sort((left, right) => {
      const timeComparison = (left.trade_time || left.tradeTime).localeCompare(right.trade_time || right.tradeTime);
      if (timeComparison !== 0) return timeComparison;
      if (left.source !== right.source) return left.source === 'existing' ? -1 : 1;
      return (left.id || left.rowNumber) - (right.id || right.rowNumber);
    });
    let quantity = 0;
    for (const transaction of combined) {
      quantity += transaction.side === 'BUY' ? transaction.quantity : -transaction.quantity;
      if (quantity < -1e-8) {
        errors.push({
          rowNumber: transaction.source === 'incoming' ? transaction.rowNumber : null,
          message: `${ticker} 在 ${String(transaction.trade_time || transaction.tradeTime).slice(0, 10)} 出现卖出股数超过可用持仓`
        });
        break;
      }
    }
  }
  return errors;
}

function validateRows(db, rows, initialErrors = []) {
  const errors = [...initialErrors];
  const seen = new Map();
  for (const row of rows) {
    const key = exactRowKey(row);
    if (seen.has(key)) errors.push({ rowNumber: row.rowNumber, message: `与第${seen.get(key)}行完全重复` });
    else seen.set(key, row.rowNumber);
  }
  errors.push(...portfolioErrors(db, rows));

  const placeholders = [...new Set(rows.map((row) => row.ticker))];
  const existing = new Set(placeholders.length
    ? toPlainRows(db.prepare(`SELECT ticker FROM watchlist_items WHERE ticker IN (${placeholders.map(() => '?').join(',')})`).all(...placeholders)).map((row) => row.ticker)
    : []);
  const addedStocks = placeholders.filter((ticker) => !existing.has(ticker)).map((ticker) => {
    const row = rows.find((candidate) => candidate.ticker === ticker);
    return { ticker, name: row?.name || ticker };
  });
  return { errors, addedStocks };
}

function decodeFile(dataBase64) {
  const encoded = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new Error('文件内容无效');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw new Error('文件为空');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('交易文件不能超过5MB');
  return buffer;
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, pending] of pendingImports) {
    if (pending.expiresAt <= now) pendingImports.delete(token);
  }
}

function previewRows(rows) {
  return rows.map(({ tradeTime, ...row }) => row);
}

export async function validateTransactionImport(db, input) {
  cleanupExpiredTokens();
  const fileName = path.basename(String(input.fileName || ''));
  const extension = path.extname(fileName).toLowerCase();
  if (!['.xlsx', '.csv'].includes(extension)) throw new Error('仅支持.xlsx或.csv交易文件');
  const buffer = decodeFile(input.dataBase64);
  const fileSha256 = createHash('sha256').update(buffer).digest('hex');
  const committed = db.prepare('SELECT id FROM transaction_import_batches WHERE file_sha256 = ?').get(fileSha256);
  if (committed) {
    return { valid: false, token: null, rowCount: 0, addedStocks: [], rows: [], errors: [{ rowNumber: null, message: '这个文件已经成功导入，不能重复导入' }] };
  }

  let parsed;
  try {
    parsed = await parseFile(buffer, extension);
  } catch (error) {
    return { valid: false, token: null, rowCount: 0, addedStocks: [], rows: [], errors: [{ rowNumber: null, message: error.message }] };
  }
  const validation = validateRows(db, parsed.rows, parsed.rowErrors);
  const valid = validation.errors.length === 0;
  const token = valid ? randomUUID() : null;
  if (valid) {
    pendingImports.set(token, {
      fileName,
      fileSha256,
      rows: parsed.rows,
      expiresAt: Date.now() + TOKEN_LIFETIME_MS
    });
  }
  return {
    valid,
    token,
    rowCount: parsed.rows.length + parsed.rowErrors.length,
    addedStocks: validation.addedStocks,
    rows: previewRows(parsed.rows),
    errors: validation.errors
  };
}

export function commitTransactionImport(db, tokenValue) {
  cleanupExpiredTokens();
  const token = String(tokenValue || '');
  const pending = pendingImports.get(token);
  if (!pending) throw new Error('预检结果已失效，请重新选择文件预检');
  const validation = validateRows(db, pending.rows);
  if (validation.errors.length) throw new Error(`交易状态已变化，请重新预检：${validation.errors[0].message}`);

  const timestamp = nowIso();
  const affectedTickers = [...new Set(pending.rows.map((row) => row.ticker))];
  db.exec('BEGIN');
  try {
    const batchResult = db.prepare(`
      INSERT INTO transaction_import_batches (file_name, file_sha256, row_count, created_at, committed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(pending.fileName, pending.fileSha256, pending.rows.length, timestamp, timestamp);
    const batchId = Number(batchResult.lastInsertRowid);
    const insertSecurity = db.prepare(`
      INSERT INTO securities (ticker, name, benchmark, currency, created_at, updated_at)
      VALUES (?, ?, 'SPY', 'USD', ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET name = COALESCE(securities.name, excluded.name), updated_at = excluded.updated_at
    `);
    const insertWatchlist = db.prepare(`
      INSERT INTO watchlist_items (ticker, enabled, note, risk_tags, continue_after_exit, created_at, updated_at)
      VALUES (?, 1, NULL, '[]', 1, ?, ?)
      ON CONFLICT(ticker) DO NOTHING
    `);
    const insertTransaction = db.prepare(`
      INSERT INTO transactions (
        ticker, side, trade_time, quantity, price, fee, note,
        import_batch_id, import_row_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const stock of validation.addedStocks) {
      insertSecurity.run(stock.ticker, stock.name, timestamp, timestamp);
      insertWatchlist.run(stock.ticker, timestamp, timestamp);
    }
    for (const row of pending.rows) {
      insertSecurity.run(row.ticker, row.name, timestamp, timestamp);
      insertTransaction.run(
        row.ticker, row.side, row.tradeTime, row.quantity, row.price, row.fee, row.note,
        batchId, row.rowNumber, timestamp, timestamp
      );
    }
    for (const ticker of affectedTickers) calculatePosition(db, ticker);
    db.exec('COMMIT');
    pendingImports.delete(token);
    return {
      imported: pending.rows.length,
      addedStocks: validation.addedStocks,
      affectedTickers,
      batchId
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
