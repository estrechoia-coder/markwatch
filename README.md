# MarkWatch

USPTO trademark status & watch API — demand-test landing page.

**This repository is a demand test, not a product.** Nothing here is a
working trademark API. The page measures interest: waitlist signups and
paid-intent plan selections. Results (including if they are low) will be
reported honestly.

- `landing.html` — single-page landing (self-contained).
- `server.js` — small Node server: serves the page, records page views /
  waitlist / paid-intent selections, aggregates at `/api/stats`. Uses
  Postgres when `DATABASE_URL` is set, else JSONL (ephemeral).
- `render.yaml` — Render Blueprint (free web service + free Postgres).

Data source: USPTO (public domain). Not affiliated with or endorsed by
USPTO. Not legal advice.

## Run locally

```
npm install
node server.js   # http://127.0.0.1:8788
```

## Stats

`GET /api/stats?internal=1` → `{storage, page_views, waitlist,
paid_intent:{total, by_plan}}`. Emails are never exposed by the API.
