"""Compute one point-in-time quality-momentum ranking for StockResearchAgent."""
import json
import sqlite3
import sys
from pathlib import Path

import pandas as pd

from quality_momentum import build_panel, rank_on


def rows(connection, sql, params):
    return [dict(row) for row in connection.execute(sql, params)]


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: compute_monthly_signal.py DATABASE SIGNAL_DATE")
    database = Path(sys.argv[1]).resolve()
    signal_date = sys.argv[2]
    root = Path(__file__).resolve().parent
    protocol = json.loads((root / "industry18_protocol.json").read_text())
    enriched = json.loads((root / "reports/industry18/enriched_snapshot.json").read_text())
    universe = protocol["universe"]
    placeholders = ",".join("?" for _ in universe)
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        facts = rows(connection, f"""
            SELECT * FROM financial_facts
            WHERE ticker IN ({placeholders}) AND filed_at <= ?
            ORDER BY ticker, filed_at, source_key
        """, (*universe, signal_date))
        filings = rows(connection, f"""
            SELECT ticker, accession_number, filed_at, accepted_at, form, filing_url
            FROM sec_filings WHERE ticker IN ({placeholders}) ORDER BY ticker, filed_at
        """, universe)
        symbols = sorted(set(universe) | {"SPY"})
        price_marks = ",".join("?" for _ in symbols)
        prices = rows(connection, f"""
            SELECT ticker, trade_date, open, high, low, close, adjusted_close, volume,
                   provider, available_at, ingested_at
            FROM prices_daily
            WHERE ticker IN ({price_marks}) AND provider = 'yahoo' AND trade_date <= ?
            ORDER BY ticker, trade_date
        """, (*symbols, signal_date))
    snapshot = {
        "universe": universe,
        "end": signal_date,
        "facts": facts,
        "filings": filings,
        "prices": prices,
        "financial_metadata": enriched.get("financial_metadata", {}),
    }
    _, frames, _ = build_panel(snapshot)
    rank = rank_on(frames, pd.Timestamp(signal_date))
    mapping = {ticker: group for group, tickers in protocol["groups"].items() for ticker in tickers}
    ordered = rank.assign(TickerKey=rank.index).sort_values(
        ["Combined", "TickerKey"], ascending=[False, True]
    )
    selected = []
    group_counts = {}
    for ticker in ordered.index:
        group = mapping[ticker]
        if group_counts.get(group, 0) >= 2:
            continue
        selected.append(ticker)
        group_counts[group] = group_counts.get(group, 0) + 1
        if len(selected) == 5:
            break
    if len(selected) != 5:
        raise RuntimeError(f"eligible universe produced {len(selected)} selections")
    rankings = []
    for ticker, item in ordered.iterrows():
        rankings.append({
            "ticker": ticker,
            "group": mapping[ticker],
            "qualityRank": round(float(item.QualityRank), 6),
            "momentumRank": round(float(item.MomentumRank), 6),
            "combined": round(float(item.Combined), 6),
            "selected": ticker in selected,
            "scoringDetails": {
                "netMarginTTM": float(item.NetMarginTTM),
                "ocfMarginTTM": float(item.OCFMarginTTM),
                "balanceSafety": float(item.BalanceSafety),
                "momentum": float(item.Momentum),
                "financialPeriod": item.FinPeriod,
                "financialKnownDay": item.FinKnownDay,
            },
        })
    print(json.dumps({"signalDate": signal_date, "rankings": rankings}, allow_nan=False))


if __name__ == "__main__":
    main()
