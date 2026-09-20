"""Read-only historical query checks against the local cache and JSON rates.

Run with the isolated test service active. Prints aggregate evidence only.
This verifies query/pricing behavior, not the correctness of source collectors.
"""
import argparse
import datetime as dt
from decimal import Decimal
import json
from pathlib import Path
import socket
import sqlite3
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1] / '.dev-data')
args = parser.parse_args()
root = args.root.resolve()
settings = json.loads((root / 'settings.json').read_text(encoding='utf-8-sig'))
prices = json.loads((root / 'prices.json').read_text(encoding='utf-8-sig'))
token = (root / 'service-token').read_text()

def rpc(method, arguments):
    with socket.create_connection(('127.0.0.1', settings['port']), timeout=30) as connection:
        connection.sendall((json.dumps(dict(token=token, method=method, args=arguments)) + '\n').encode())
        result = json.loads(connection.makefile(encoding='utf-8').readline())
    if not result['ok']:
        raise RuntimeError(result.get('error', 'Local request failed'))
    return result['result']

def effective(rate):
    value = rate.get('effectiveFrom')
    return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000) if value else 0

def cost(event):
    model = prices.get('aliases', {}).get(event['model'], event['model'])
    rates = [rate for rate in prices['models'].get(model, []) if effective(rate) <= event['ts']]
    if not rates:
        return None
    rate = max(rates, key=effective)
    return sum(Decimal(event['tokens'][key]) * Decimal(str(rate[key])) for key in ('input', 'cached', 'cacheWrite', 'output')) / Decimal(1_000_000)

cache = sqlite3.connect(f'{root.joinpath("events-v2.sqlite").as_uri()}?mode=ro', uri=True)
# Completed historical windows avoid most changes from currently streaming logs.
end = int(time.time() // 60) * 60000 - 86400000
agents = list(settings['roots'])
evidence = []
for minutes in (300, 10080):
    for agent in [None, *agents]:
        query = dict(start=end-minutes*60000, end=end, agent=agent, model=None, project=None, session=None, search='', offsetMinutes=480)
        rows = [json.loads(row[0]) for row in cache.execute('SELECT data FROM events WHERE ts>=? AND ts<? AND (? IS NULL OR agent=?)', (query['start'], end, agent, agent))]
        started = time.perf_counter()
        dashboard = rpc('dashboard', dict(query=query))
        elapsed = round((time.perf_counter()-started)*1000)
        totals = dashboard['totals']
        assert totals['events'] == len(rows), (agent, minutes, 'event count')
        for field in ('input', 'cached', 'cacheWrite', 'output', 'reasoning'):
            assert totals['tokens'][field] == sum(row['tokens'][field] for row in rows), (agent, minutes, field)
        expected_total = sum(sum(row['tokens'][field] for field in ('input', 'cached', 'cacheWrite', 'output')) for row in rows)
        assert totals['totalTokens'] == expected_total
        estimated = [cost(row) for row in rows]
        known = sum((value for value in estimated if value is not None), Decimal(0))
        unknown = sum(value is None for value in estimated)
        assert totals['unpricedEvents'] == unknown
        assert abs(Decimal(str(totals['knownCostUsd']))-known) <= max(Decimal('0.00000001'), abs(known)*Decimal('0.000000001'))
        assert (totals['costUsd'] is None) == bool(unknown)
        for grouping in ('models','projects','sessions','agents','days','months','series'):
            assert sum(row['totalTokens'] for row in dashboard[grouping]) == expected_total, (agent, minutes, grouping)
        expected_buckets = (300,) if minutes == 300 else (168,169)  # partial boundary hours
        assert len(dashboard['series']) in expected_buckets
        activities = rpc('activities', dict(query=query, offset=0, limit=100))
        assert activities['total'] == dashboard['activityCount'] == sum(dashboard['tools'].values())
        assert len(activities['items']) == min(100, activities['total'])
        assert all(query['start'] <= item['ts'] < end and (agent is None or item['agent'] == agent) for item in activities['items'])
        evidence.append(dict(agent=agent or 'all',minutes=minutes,events=len(rows),tokens=expected_total,unknownPrices=unknown,queryMs=elapsed))
cache.close()
print(json.dumps(dict(checks=len(evidence),windowsEnd=end,results=evidence),ensure_ascii=False,indent=2))
