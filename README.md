# MarkWatch

USPTO trademark status & watch API — demand-test landing page.

**This repository is a demand test, not a product.** Nothing here is a
working trademark API. The page measures interest: waitlist signups and
paid-intent plan selections. Results (including if they are low) will be
reported honestly.

- `landing.html` — single-page landing (self-contained).
- `server.js` — small Node server: serves the page, records page views /
  waitlist / paid-intent selections, aggregates at `/api/stats`. Storage
  priority: Postgres (`DATABASE_URL`) → Upstash Redis REST
  (`UPSTASH_REST_URL` + `UPSTASH_REST_TOKEN`) → JSONL (ephemeral, dev only).
- `render.yaml` — Render Blueprint (free web service only; Render allows one
  free database per account, so durable storage is a free external store set
  via the dashboard env — never committed here).

## Run locally

```
npm install
node server.js   # http://127.0.0.1:8788 (jsonl, ephemeral)
```

## Stats

`GET /api/stats?internal=1` → `{storage, page_views, waitlist,
paid_intent:{total, by_plan}}`. Emails are never exposed by the API.
