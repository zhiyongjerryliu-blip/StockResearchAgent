const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`交易日期格式无效：${value}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`交易日期无效：${value}`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function nthWeekday(year, month, weekday, occurrence) {
  const date = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + (occurrence - 1) * 7);
  return date;
}

function lastWeekday(year, month, weekday) {
  const date = new Date(Date.UTC(year, month + 1, 0));
  const offset = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date;
}

function observedFixedHoliday(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

// Meeus/Jones/Butcher Gregorian Easter algorithm.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function regularMarketHolidays(year) {
  const holidays = new Set();
  const add = (date) => {
    if (date.getUTCFullYear() === year) holidays.add(formatDate(date));
  };

  // Include adjacent source years because an observed New Year's Day can fall
  // on December 31 of the preceding calendar year.
  for (const sourceYear of [year - 1, year, year + 1]) {
    add(observedFixedHoliday(sourceYear, 0, 1));
    add(observedFixedHoliday(sourceYear, 6, 4));
    add(observedFixedHoliday(sourceYear, 11, 25));
    if (sourceYear >= 2022) add(observedFixedHoliday(sourceYear, 5, 19));
  }

  if (year >= 1998) add(nthWeekday(year, 0, 1, 3)); // Martin Luther King Jr. Day
  add(nthWeekday(year, 1, 1, 3)); // Washington's Birthday
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  add(goodFriday);
  add(lastWeekday(year, 4, 1)); // Memorial Day
  add(nthWeekday(year, 8, 1, 1)); // Labor Day
  add(nthWeekday(year, 10, 4, 4)); // Thanksgiving Day
  return holidays;
}

const holidayCache = new Map();

export function isRegularUsTradingDay(tradeDate) {
  const date = dateOnly(tradeDate);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const year = date.getUTCFullYear();
  if (!holidayCache.has(year)) holidayCache.set(year, regularMarketHolidays(year));
  return !holidayCache.get(year).has(tradeDate);
}

export function previousRegularUsTradingDate(tradeDate) {
  const date = dateOnly(tradeDate);
  do {
    date.setTime(date.getTime() - DAY_MS);
  } while (!isRegularUsTradingDay(formatDate(date)));
  return formatDate(date);
}

export function nextRegularUsTradingDate(tradeDate) {
  const date = dateOnly(tradeDate);
  do {
    date.setTime(date.getTime() + DAY_MS);
  } while (!isRegularUsTradingDay(formatDate(date)));
  return formatDate(date);
}

export function latestStableUsMarketDate(
  date = new Date(), stableHourEt = 18, stableMinuteEt = 15
) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const currentDate = `${values.year}-${values.month}-${values.day}`;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const stableMinutes = stableHourEt * 60 + stableMinuteEt;
  if (isRegularUsTradingDay(currentDate) && minutes >= stableMinutes) return currentDate;
  return previousRegularUsTradingDate(currentDate);
}
