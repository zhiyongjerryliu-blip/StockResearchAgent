export function normalizeTicker(value) {
  const ticker = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(ticker)) {
    throw new Error('股票代码格式无效');
  }
  return ticker;
}

export function positiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName}必须大于0`);
  }
  return number;
}

export function nonNegativeNumber(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName}不能小于0`);
  }
  return number;
}

export function isoDate(value, fieldName = '日期') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName}无效`);
  return date.toISOString();
}

export function round(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
