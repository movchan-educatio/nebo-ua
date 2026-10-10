# UkraineAlarm API — HTTP 401: findings

> **Outcome: the source was retired on 2026-10-10** by owner decision. Support
> is not being contacted and no new key will be sought. It is switched off in
> `backend/wrangler.toml` with `OFFICIAL_SOURCE_ENABLED = "false"`, which fails
> closed and is checked before any request is built. The adapter stays in the
> repository, so one config line brings it back.
>
> This document is kept as the record of the diagnosis.

Status: **diagnosed, not fixable in code.** The credential is rejected by the
provider. This document records what was proven, how, and what remains open.

No auth scheme was changed. No provider limit was circumvented. No request rate
was increased. The API key never appears in a log, a test, a commit or this
report.

---

## 1. The credential exists

```
$ wrangler secret list
  UKRAINEALARM_API_KEY   secret_text
```

The Worker does issue requests to the API. With no secret the source reports
`disabled` and no request is ever made; we observe `auth_rejected` failures,
which is the `offline` path. So a non-empty secret is present in the Worker.

## 2. The integration is correct — it has worked before

`checks` table, `source='OFFICIAL'`, grouped by hour:

```
hour              ok / total
2026-10-08T12      0 / 60
2026-10-08T13      0 / 59
2026-10-08T14      0 / 50
2026-10-08T15      4 / 52    ← first success
2026-10-08T16     18 / 47
2026-10-08T17     15 / 43
2026-10-08T18     17 / 43
2026-10-08T19      0 / 34
2026-10-08T20      0 /  5
2026-10-08T21      2 /  7
2026-10-08T22      5 / 10
2026-10-08T23     15 / 38
2026-10-09T00     11 / 24
2026-10-09T01     14 / 42
2026-10-09T02      0 /  2
2026-10-09T03      5 / 11    ← last success, 03:38:37Z
2026-10-09T04      0 / 20    ← never succeeded again
…                0 / …       (to 2026-10-10T01:00Z)
```

Totals: **106 successful cycles, 6307 failures.** `journal` holds **79
OFFICIAL records**, the newest at `2026-10-09T01:36:36Z`.

The same code, the same scheme and the same key parsed real alerts. So the
endpoint paths, the response parsing and the alert model are correct.

## 3. The auth scheme was never changed

`UKRAINEALARM_AUTH_SCHEME = ""` (raw key) is identical on `HEAD`,
`integration/ukrainealarm-v3`, `feature/ua-full-integration` and
`audit/ua-401-403-conformance`. There is no configuration regression.

## 4. The provider gives us no diagnostic signal

Live probe against `https://api.ukrainealarm.com`:

| request                          | status | content-type | body       |
|----------------------------------|--------|--------------|------------|
| no `Authorization` header        | 403    | text/html    | Cloudflare challenge page |
| `Authorization: <invalid>`       | 401    | —            | empty      |
| `Authorization: Token <invalid>` | 401    | —            | empty      |
| `Authorization: Bearer <invalid>`| 401    | —            | empty      |

No `WWW-Authenticate`, no `Retry-After`, no body. **Every auth scheme produces
an identical 401**, so the response cannot distinguish a wrong scheme from a
revoked key. This is why the adapter reports the class and defers the cause to
the provider rather than guessing.

Note the 403 is an **edge bot challenge**, not a credential failure — it comes
with an HTML Cloudflare page and no auth header at all. The adapter classifies
those separately as `edge_blocked`.

## 5. Unexplained anomaly — reported, not explained

Live Worker telemetry, same key, same minute:

```
/api/v3/alerts/status   200   (638ms)
/api/v3/alerts          401   ( 18ms)
```

`/api/v3/alerts/status` intermittently returns 200 while `/api/v3/alerts`
returns 401 every time it is reached. This could not be reproduced from outside
with an invalid key, and it is not explained by anything in our request
construction — both endpoints go through a single `uaFetch` choke point that
builds the `Authorization` header in exactly one place (pinned by a test).

It is characteristic of provider-side key state that flaps (partial revocation,
an inconsistent key store across edge nodes, or a quota enforced as 401 rather
than 429). **This is a hypothesis, not a finding.**

---

## What was added (not deployed)

`backend/src/ukrainealarm.js`:

- `describeKey(key, scheme)` — presence, length, trimmed length, surrounding
  whitespace, whitespace count, non-ASCII count. Never the value.
- `keyFingerprint(key)` — truncated HMAC-SHA256 (12 hex chars) under the
  public constant `UA_FP_PEPPER`. Irreversible; reproducible by the key holder
  via `node tools/ua-fingerprint.mjs`.
- `classifyUaResponse(status, contentType)` — `ok`, `auth_rejected`,
  `edge_blocked`, `forbidden`, `endpoint_missing`, `rate_limited`, `timeout`,
  `upstream_error`, `network`, `http_<n>`.
- Per-endpoint telemetry: `endpoint`, `status`, `class`, `durationMs`,
  `scheme`, `keyFp` — the last two are identical across endpoints, which is the
  runtime proof that both are configured the same way.
- A once-per-cycle `auth-config` record describing the credential's shape.

`tools/ua-fingerprint.mjs` computes the same fingerprint locally so the holder
can confirm the Worker holds the key they think it does.
`tools/ua-diag-local.mjs` exercises the real adapter against the real API.

Tests: `backend/test/ukrainealarm-diag.test.js`, 13 cases, including a guard
that no `console.log` in the adapter can receive the key or the header value.

Writing them caught one real defect: the fingerprint memo cache was keyed on
the key alone and ignored the pepper, so it would have returned a stale value
if the pepper ever changed. Fixed and covered.

**Deployment is not authorised and has not been performed.**

---

## Open question only the provider can answer

Is the key expired, revoked, quota-exhausted or throttled — and why does
`/api/v3/alerts/status` still intermittently succeed with it?

Until that is answered the source honestly reports `offline` and the site never
shows a false all-clear. NEPTUN and MAPA are unaffected.
