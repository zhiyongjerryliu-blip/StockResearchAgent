import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { providerFromName } from './market.js';
import { runMarketRefreshCycle } from './scheduler.js';

export async function executeWorkerMarketRefresh(input = {}) {
  const db = openDatabase(input.databasePath || config.databasePath);
  try {
    return await runMarketRefreshCycle(
      db, providerFromName(config.marketDataProvider),
      new Date(input.requestedAt || Date.now())
    );
  } finally {
    db.close();
  }
}

if (!isMainThread && parentPort) {
  executeWorkerMarketRefresh(workerData).then(
    result => parentPort.postMessage({ ok: true, result }),
    error => parentPort.postMessage({ ok: false, error: error?.message || String(error) })
  );
}
