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

            # Locked to Monthly Total Return, longest history available.
            # No client override of datapoint, frequency, or start date —
            # this avoids accidentally pulling Price Return or daily data.
            start_date = "1970-01-01"
            end_date = datetime.utcnow().strftime("%Y-%m-%d")
            datapoint = "HP010"

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

            # Full datapoint setting matching what MS Direct's Analytics Lab
            # emits for the "Monthly Return" datapoint (HP010, calculationId=1).
            # All the calc* fields determine WHICH of the 36 grouped variants
            # of Monthly Return you get — these match a standard total return
            # in base currency, % units.
            # Same settings as MS Direct Analytics Lab's "Monthly Return"
            # (HP010, calculationId=1) — but with calcUse5Days off so the
            # request isn't silently capped to ~25 years of history. Some
            # securities (e.g. SPY launched 1993) carry NAV further back
            # than that and we want to surface it.
            data_points = [
                {
                    "datapointId": datapoint,
                    "datapointName": "Monthly Return",
                    "calculationId": "1",
                    "isTsdp": True,
                    "frequency": "m",
                    "startDate": start_date,
                    "endDate": end_date,
                    "currency": "BASE",
                    "calcCurType": "Return",
                    "calcSdType": "r",
                    "calcUse5Days": False,
                    "compounding": "0",
                    "annualized": False,
                    "isEpdp": True,
                }
            ]

            df = md.direct.get_investment_data(
                investments=[investment], data_points=data_points
            )

            # Normalize the DataFrame into [{date, value}] entries.
            returns: list = []
            sample_row = None
            columns: list = []
            if df is not None and len(df) > 0:
                columns = list(df.columns)
                # Pick the first row as a debug sample
                try:
                    sample_row = {k: str(v)[:80] for k, v in df.iloc[0].to_dict().items()}
                except Exception:
                    pass

                # Detect (date, value) columns. MS-Direct DataFrames for time
                # series usually look like one of:
                #   long  → ['Id', 'Name', 'Date', 'HP010']
                #   wide  → ['Id', 'Name', '2020-01-31', '2020-02-29', ...]
                date_col = None
                value_col = None
                for cand in ("Date", "date", "AsOfDate", "asOfDate"):
                    if cand in df.columns:
                        date_col = cand
                        break
                for cand in (
                    datapoint,
                    f"{datapoint}_value",
                    "Monthly Return",
                    "Value",
                    "value",
                ):
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
                            v_dec = float(v) / 100.0
                            returns.append({"date": d_str, "value": v_dec})
                        except Exception:
                            continue
                else:
                    # Wide format: column names contain an ISO date — the
                    # MS-Direct shape is one row per security, columns like
                    # "Monthly Return 2000-01-31", "Monthly Return 2000-02-29",
                    # ... so extract the date from each column name.
                    import re as _re

                    iso_anywhere = _re.compile(r"(\d{4}-\d{2}-\d{2})")
                    date_cols_with_iso = []
                    for c in df.columns:
                        if isinstance(c, str):
                            m = iso_anywhere.search(c)
                            if m:
                                date_cols_with_iso.append((c, m.group(1)))
                    if date_cols_with_iso and len(df) >= 1:
                        row0 = df.iloc[0]
                        for col_name, iso_date in date_cols_with_iso:
                            v = row0[col_name]
                            if v is None:
                                continue
                            try:
                                fv = float(v)
                                if fv != fv:  # NaN check
                                    continue
                                returns.append({"date": iso_date, "value": fv / 100.0})
                            except Exception:
                                continue
                        # Sort by date
                        returns.sort(key=lambda r: r["date"])

            _send(
                self,
                {
                    "datapoint": datapoint,
                    "identifier": {"isin": isin, "ticker": ticker, "secid": secid},
                    "rows": len(returns),
                    "returns": returns,
                    "schema_columns": columns,
                    "sample_row": sample_row,
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
