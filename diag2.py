import sqlite3

c = sqlite3.connect("state/jamasp.db")
c.row_factory = sqlite3.Row

print("=== mining_weekly: is the bad-date problem still happening? ===")
for r in c.execute(
    "SELECT substr(fetched_at,1,10) day, COUNT(*) n,"
    " SUM(CASE WHEN i.published_at < '1900' THEN 1 ELSE 0 END) bad,"
    " MIN(i.published_at) minp, MAX(i.published_at) maxp"
    " FROM items i WHERE i.source = 'mining_weekly'"
    " GROUP BY day ORDER BY day"
):
    print(f"  {r['day']}  items={r['n']:3} bad_dates={r['bad']:3}"
          f"  range {r['minp'][:10]} .. {r['maxp'][:10]}")

print("\n=== a few actual mining_weekly rows ===")
for r in c.execute(
    "SELECT published_at, fetched_at, headline, url FROM items"
    " WHERE source = 'mining_weekly' ORDER BY fetched_at DESC LIMIT 5"
):
    print(f"  pub={r['published_at']} fetched={r['fetched_at']}")
    print(f"     {r['headline'][:70]}")
    print(f"     {r['url'][:96]}")

print("\n=== do any sources besides mining_weekly have pre-1900 dates? ===")
for r in c.execute(
    "SELECT source, COUNT(*) n, MIN(published_at) minp, MAX(published_at) maxp"
    " FROM items WHERE published_at < '1900' GROUP BY source ORDER BY n DESC"
):
    print(f"  {r['source']}: {r['n']} items, {r['minp'][:10]} .. {r['maxp'][:10]}")

print("\n=== national_business: which items were postable? ===")
for r in c.execute(
    "SELECT SUM(CASE WHEN published_at > '2026-08-01' THEN 1 ELSE 0 END) recent,"
    " SUM(CASE WHEN published_at <= '2026-08-01' THEN 1 ELSE 0 END) older,"
    " COUNT(*) total FROM items WHERE source = 'national_business'"
):
    print(f"  total={r['total']} published_after_aug1={r['recent']} older={r['older']}")
for r in c.execute(
    "SELECT substr(fetched_at,1,10) day, COUNT(*) n,"
    " CAST(AVG((julianday(fetched_at) - julianday(published_at)) * 24) AS INT) avg_age_h"
    " FROM items WHERE source = 'national_business'"
    " GROUP BY day ORDER BY day DESC LIMIT 6"
):
    print(f"  {r['day']} items={r['n']:3} avg_age={r['avg_age_h']}h")
