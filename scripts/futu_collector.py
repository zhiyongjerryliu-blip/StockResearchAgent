#!/usr/bin/env python3
"""Read-only Futu OpenD quote collector for StockResearchAgent."""

import argparse
import json
import math
import signal
import sys
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from futu import (
    AuType,
    CurKlineHandlerBase,
    KLType,
    OpenQuoteContext,
    RET_OK,
    Session,
    SubType,
    TickerHandlerBase,
)


EVENT_PREFIX = "__FUTU_EVENT__"
PRINT_LOCK = threading.Lock()
RUNNING = True


def emit(payload):
    with PRINT_LOCK:
        print(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def finite_number(value, integer=False):
    try:
        number = float(value)
        if not math.isfinite(number):
            return None
        return int(number) if integer else number
    except (TypeError, ValueError):
        return None


def normalize_ticker(code):
    return str(code).split(".", 1)[-1].upper()


def frame_records(frame):
    if frame is None or not hasattr(frame, "to_dict"):
        return []
    return frame.to_dict("records")


def normalize_bars(frame, session, is_final):
    records = []
    rows = frame_records(frame)
    latest_time = max((str(row.get("time_key") or "") for row in rows), default="")
    for row in rows:
        time_key = str(row.get("time_key") or "")
        close = finite_number(row.get("close"))
        if not time_key or close is None:
            continue
        records.append({
            "ticker": normalize_ticker(row.get("code")),
            "barTimeEt": time_key,
            "tradeDate": time_key[:10],
            "interval": "1M",
            "session": session,
            "open": finite_number(row.get("open")),
            "high": finite_number(row.get("high")),
            "low": finite_number(row.get("low")),
            "close": close,
            "volume": finite_number(row.get("volume"), integer=True),
            "turnover": finite_number(row.get("turnover")),
            "isFinal": bool(is_final or time_key != latest_time),
        })
    return records


def normalize_ticks(frame, session):
    records = []
    for row in frame_records(frame):
        sequence = row.get("sequence")
        trade_time = str(row.get("time") or "")
        price = finite_number(row.get("price"))
        volume = finite_number(row.get("volume"), integer=True)
        turnover = finite_number(row.get("turnover"))
        if sequence is None or not trade_time or price is None or volume is None:
            continue
        records.append({
            "ticker": normalize_ticker(row.get("code")),
            "sequence": str(sequence),
            "tradeTimeEt": trade_time,
            "tradeDate": trade_time[:10],
            "price": price,
            "volume": volume,
            "turnover": turnover if turnover is not None else price * volume,
            "direction": str(row.get("ticker_direction") or "NONE").upper(),
            "tradeType": str(row.get("type") or ""),
            "session": session,
        })
    return records


def emit_chunks(event_type, key, records, size=250):
    for index in range(0, len(records), size):
        emit({"type": event_type, key: records[index:index + size]})


class KlineHandler(CurKlineHandlerBase):
    def __init__(self, session):
        super().__init__()
        self.session = session

    def on_recv_rsp(self, response):
        ret_code, data = super().on_recv_rsp(response)
        if ret_code != RET_OK:
            emit({"type": "error", "scope": "kline_push", "message": str(data)})
            return ret_code, data
        emit_chunks("bars", "bars", normalize_bars(data, self.session, False))
        return ret_code, data


class TickHandler(TickerHandlerBase):
    def __init__(self, session):
        super().__init__()
        self.session = session

    def on_recv_rsp(self, response):
        ret_code, data = super().on_recv_rsp(response)
        if ret_code != RET_OK:
            emit({"type": "error", "scope": "ticker_push", "message": str(data)})
            return ret_code, data
        emit_chunks("ticks", "ticks", normalize_ticks(data, self.session))
        return ret_code, data


def session_value(name):
    return {
        "RTH": Session.RTH,
        "ETH": Session.ETH,
        "ALL": Session.ALL,
    }.get(name.upper(), Session.RTH)


def backfill_history(context, codes, session_name, session, days):
    if days <= 0:
        return
    today = datetime.now(ZoneInfo("America/New_York")).date()
    start = (today - timedelta(days=days)).isoformat()
    end = today.isoformat()
    for code in codes:
        page_key = None
        total = 0
        while RUNNING:
            ret_code, data, page_key = context.request_history_kline(
                code,
                start=start,
                end=end,
                ktype=KLType.K_1M,
                autype=AuType.NONE,
                max_count=1000,
                page_req_key=page_key,
                session=session,
            )
            if ret_code != RET_OK:
                emit({"type": "error", "scope": "history", "ticker": normalize_ticker(code), "message": str(data)})
                break
            bars = normalize_bars(data, session_name, True)
            total += len(bars)
            emit_chunks("bars", "bars", bars)
            if page_key is None:
                break
            time.sleep(0.55)
        emit({"type": "backfill", "ticker": normalize_ticker(code), "bars": total, "start": start, "end": end})


def stop_collector(_signum, _frame):
    global RUNNING
    RUNNING = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11111)
    parser.add_argument("--symbols", required=True)
    parser.add_argument("--backfill-symbols", default="")
    parser.add_argument("--session", choices=["RTH", "ETH", "ALL"], default="RTH")
    parser.add_argument("--backfill-days", type=int, default=35)
    args = parser.parse_args()

    tickers = sorted({ticker.strip().upper() for ticker in args.symbols.split(",") if ticker.strip()})
    codes = [f"US.{ticker}" for ticker in tickers]
    backfill_tickers = {
        ticker.strip().upper() for ticker in args.backfill_symbols.split(",") if ticker.strip()
    }
    backfill_codes = [f"US.{ticker}" for ticker in tickers if ticker in backfill_tickers]
    if not codes:
        emit({"type": "error", "scope": "startup", "message": "股票列表为空"})
        return 2

    signal.signal(signal.SIGINT, stop_collector)
    signal.signal(signal.SIGTERM, stop_collector)
    session = session_value(args.session)
    context = OpenQuoteContext(host=args.host, port=args.port)
    try:
        context.set_handler(KlineHandler(args.session))
        context.set_handler(TickHandler(args.session))
        ret_code, message = context.subscribe(
            codes,
            [SubType.K_1M, SubType.TICKER],
            is_first_push=True,
            subscribe_push=True,
            session=session,
        )
        if ret_code != RET_OK:
            emit({"type": "error", "scope": "subscribe", "message": str(message)})
            return 1

        emit({"type": "status", "status": "connected", "symbols": tickers, "session": args.session})
        for code in codes:
            ret_code, data = context.get_cur_kline(code, 1000, KLType.K_1M, AuType.NONE)
            if ret_code == RET_OK:
                emit_chunks("bars", "bars", normalize_bars(data, args.session, True))
            ret_code, data = context.get_rt_ticker(code, 1000)
            if ret_code == RET_OK:
                emit_chunks("ticks", "ticks", normalize_ticks(data, args.session))

        backfill_history(context, backfill_codes, args.session, session, args.backfill_days)
        while RUNNING:
            emit({"type": "heartbeat", "time": datetime.now().isoformat(timespec="seconds")})
            time.sleep(30)
    except Exception as error:
        emit({"type": "error", "scope": "collector", "message": str(error)})
        return 1
    finally:
        try:
            context.unsubscribe(codes, [SubType.K_1M, SubType.TICKER])
        except Exception:
            pass
        context.close()
        emit({"type": "status", "status": "stopped"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
