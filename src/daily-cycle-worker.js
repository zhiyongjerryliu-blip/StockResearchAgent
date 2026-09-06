import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { providerFromName } from './market.js';
import { SecEdgarProvider } from './sec.js';
import { AlphaVantageEarningsProvider } from './earnings-estimates.js';
import { AlphaVantageNewsProvider } from './news.js';
import {
  CompositeNewsProvider, GoogleNewsRssProvider, HackerNewsDiscussionProvider,
  YahooFinanceNewsProvider
} from './news-sources.js';
import { runDailyCycle } from './scheduler.js';

export async function executeWorkerDailyCycle(input = {}) {
  const db = openDatabase(input.databasePath || config.databasePath);
  try {
    const provider = providerFromName(config.marketDataProvider);
    const secProvider = new SecEdgarProvider(config.sec);
    const earningsProvider = new AlphaVantageEarningsProvider(config.alphaVantage);
    const newsProvider = new CompositeNewsProvider([
      new AlphaVantageNewsProvider(config.alphaVantage),
      new GoogleNewsRssProvider(),
      new YahooFinanceNewsProvider(),
      new HackerNewsDiscussionProvider()
    ]);
    return await runDailyCycle(
      db, provider, new Date(input.requestedAt || Date.now()),
      secProvider, earningsProvider, newsProvider, input.options || {}
    );
  } finally {
    db.close();
  }
}

if (!isMainThread && parentPort) {
  executeWorkerDailyCycle(workerData).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (error) => parentPort.postMessage({
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || null
    })
  );
}
