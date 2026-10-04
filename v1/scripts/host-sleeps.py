# Lists every system sleep of 30 s or more since a given time, from the machine's
# power log (macOS `pmset -g log`), and writes them as JSON for
# relabel-host-suspended.mjs.
#   python3 v1/scripts/host-sleeps.py --since 2026-10-03T11:21:00Z --out sleeps.json
import re, json, subprocess, datetime as dt, argparse
parser = argparse.ArgumentParser()
parser.add_argument('--since', required=True, help='ISO time; sleeps ending before it are ignored')
parser.add_argument('--out', required=True)
args = parser.parse_args()
log = subprocess.run(['pmset', '-g', 'log'], capture_output=True, text=True, errors='ignore').stdout
events = []
for line in log.splitlines():
    # "Wake Requests", "WakeDetails" and assertion lines are bookkeeping, not state changes.
    m = re.match(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d{4})\s+(Sleep|Wake|DarkWake)\s+(?!Requests)', line)
    if m: events.append((dt.datetime.strptime(m.group(1) + ' ' + m.group(2), '%Y-%m-%d %H:%M:%S %z'), m.group(3)))
events.sort()
sleeps, start = [], None
for at, kind in events:
    if kind == 'Sleep':
        if start is None: start = at
    elif start is not None:
        sleeps.append((start, at)); start = None
run_start = dt.datetime.fromisoformat(args.since.replace('Z', '+00:00'))
sleeps = [(a, b) for a, b in sleeps if b > run_start and (b - a).total_seconds() >= 30]
json.dump([[a.isoformat(), b.isoformat()] for a, b in sleeps], open(args.out, 'w'))
for a, b in sleeps:
    print(a.astimezone(dt.timezone.utc).strftime('%m-%d %H:%M:%S'), '->', b.astimezone(dt.timezone.utc).strftime('%m-%d %H:%M:%S'), '%5.0f s' % (b - a).total_seconds())
print(len(sleeps), 'sleep intervals')
