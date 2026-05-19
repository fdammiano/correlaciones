# Vercel Python serverless function that fetches monthly total returns from
# Morningstar Direct via the morningstar-data SDK.
#
# URL: /api/morningstar?isin=...&start=2000-01-01&end=2026-05-31
# Alt identifiers: ?ticker=... or ?secid=...
# Optional: ?datapoint=...  (override of MD_TR_DATAPOINT env var)
#
# Required env vars on Vercel:
#   MD_AUTH_TOKEN    Morningstar Direct API token
# Optional:
#   MD_TR_DATAPOINT  default datapoint id for monthly total return
#                    (fallback "OS018" — VERIFY in your Direct instance)

import json
import os
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse


def _send(handler, payload, status=200):
    body = json.dumps(payload, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel expects lowercase
    def do_GET(self):  # noqa: N802
        try:
            qs = parse_qs(urlparse(self.path).query)

            isin = (qs.get("isin", [None])[0] or "").strip() or None
            ticker = (qs.get("ticker", [None])[0] or "").strip() or None
            secid = (qs.get("secid", [None])[0] or "").strip() or None
            if not (isin or ticker or secid):
                _send(self, {"error": "Pass one of isin, ticker, or secid."}, 400)
                return

            start_date = qs.get("start", ["2000-01-01"])[0]
            end_date = qs.get("end", [datetime.utcnow().strftime("%Y-%m-%d")])[0]
            datapoint = qs.get(
                "datapoint",
                [os.environ.get("MD_TR_DATAPOINT", "OS018")],
            )[0]

            token = os.environ.get("MD_AUTH_TOKEN")
            if not token:
                _send(self, {"error": "MD_AUTH_TOKEN no está configurado en Vercel."}, 503)
                return

            try:
                import morningstar_data as md
                from morningstar_data.direct import InvestmentIdentifier
            except Exception as e:
                _send(
                    self,
                    {
                        "error": "morningstar_data no se pudo importar.",
                        "detail": str(e),
                    },
                    500,
                )
                return

            os.environ["MD_AUTH_TOKEN"] = token

            if isin:
                investment = InvestmentIdentifier(isin=isin)
            elif ticker:
                investment = InvestmentIdentifier(ticker=ticker)
            else:
                investment = InvestmentIdentifier(secId=secid)

            data_points = [
                {
                    "datapointId": datapoint,
                    "isTsdp": True,
                    "startDate": start_date,
                    "endDate": end_date,
                    "frequency": "Monthly",
                }
            ]

            df = md.direct.get_investment_data(
                investments=[investment], data_points=data_points
            )

            # Normalize the DataFrame into [{date, value}] entries.
            # Schema returned by md.direct.get_investment_data varies per
            # datapoint shape — try the common conventions in order.
            returns = []
            if df is not None and len(df) > 0:
                # Convention A: long format with columns ['Date', <datapointId>]
                date_col = None
                value_col = None
                for cand in ("Date", "date", "AsOfDate", "asOfDate"):
                    if cand in df.columns:
                        date_col = cand
                        break
                for cand in (datapoint, f"{datapoint}_value", "Value", "value"):
                    if cand in df.columns:
                        value_col = cand
                        break
                if date_col and value_col:
                    for _, row in df.iterrows():
                        d = row[date_col]
                        v = row[value_col]
                        if d is None or v is None:
                            continue
                        try:
                            d_str = str(d)[:10]
                            v_dec = float(v) / 100.0  # MD returns % as a number
                            returns.append({"date": d_str, "value": v_dec})
                        except Exception:
                            continue

            _send(
                self,
                {
                    "datapoint": datapoint,
                    "identifier": {"isin": isin, "ticker": ticker, "secid": secid},
                    "rows": len(returns),
                    "returns": returns,
                    "schema_columns": list(df.columns) if df is not None else [],
                },
            )
        except Exception as e:
            _send(
                self,
                {
                    "error": "Unhandled exception",
                    "detail": str(e),
                    "trace": traceback.format_exc(),
                },
                500,
            )
