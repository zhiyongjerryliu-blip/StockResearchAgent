// Reuse the existing pure read-only analyzer against a frozen, adjusted price table.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyzeCapitalFlow, CAPITAL_FLOW_MODEL_VERSION } from '../src/capital-flow.js';

export function analyzeFrozenRows(rows) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE prices_daily (ticker TEXT,trade_date TEXT,open REAL,high REAL,low REAL,close REAL,volume REAL,provider TEXT,ingested_at TEXT,PRIMARY KEY(ticker,trade_date))');
    const insert = db.prepare('INSERT INTO prices_daily VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of rows) {
      insert.run('LITE',row.Date,row.Open,row.High,row.Low,row.Close,row.Volume,'frozen_adjusted','');
    }
    db.exec('PRAGMA query_only=ON');
    return {
      model_version: CAPITAL_FLOW_MODEL_VERSION,
      price_basis: '冻结复权OHLC＋供应商成交量；与成交回测相同序列，非实际历史成交金额',
      rows: rows.map(row => {
        const result = analyzeCapitalFlow(db,'LITE',row.Date);
        return {Date:row.Date,priceDate:result.priceDate,close:result.close,score:result.signal==='INSUFFICIENT'?null:result.score,
                signal:result.signal,confidence:result.confidence,dataLevel:result.dataLevel,
                metrics:result.metrics};
      })
    };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
  writeFileSync(process.argv[3],JSON.stringify(analyzeFrozenRows(input),null,2));
}
