# Letter to UkraineAlarm API support

Subject: API key returns 401 for every request since 2026-10-09 03:38 UTC —
request for diagnosis

---

Hello,

Our API key has been rejected by `https://api.ukrainealarm.com` since
**2026-10-09 03:38:37 UTC**. Before that it worked. We believe the fault is on
your side, but we cannot prove it from the outside because the 401 carries no
diagnostic information. Could you please check the key in your system and tell
us why it is being rejected?

## What we send

```
GET https://api.ukrainealarm.com/api/v3/alerts/status
GET https://api.ukrainealarm.com/api/v3/alerts

Host: api.ukrainealarm.com
Accept: application/json
User-Agent: nebo-ua-check-proxy/1.0 (+https://nebo-ua.vercel.app)
Authorization: <our API key, raw — no "Token"/"Bearer" prefix>
```

Rate: one `/alerts/status` call per minute (1,440/day), `/alerts` only when the
returned `lastActionIndex` changes. `/regions` is cached for 7 days and
refreshed at most once every 24 hours. We have not increased this and are not
asking you to lift any limit.

## What we observe

```
GET /api/v3/alerts/status  -> HTTP 401, empty body, no WWW-Authenticate
GET /api/v3/alerts         -> HTTP 401, empty body, no WWW-Authenticate
```

Every attempt, every minute, for roughly 21 hours and counting.

To rule out our own request construction we tested the auth header variants
against your API directly. All three behave identically:

```
no Authorization header        -> 403 text/html   (Cloudflare bot challenge)
Authorization: <invalid key>   -> 401 (empty)
Authorization: Token <invalid> -> 401 (empty)
Authorization: Bearer <invalid>-> 401 (empty)
```

Because the 401 body is empty and no `WWW-Authenticate` header is returned, the
response does not distinguish an invalid key from a revoked key, an expired key,
or a key whose quota is exhausted. That ambiguity is why we are writing to you
rather than continuing to guess.

## Timeline

```
2026-10-04T19:40Z  first request from our integration -> 401
2026-10-08T15:52Z  first successful responses (4 that hour, 18 the next)
2026-10-08T16:00 - 2026-10-09T01:36Z   partial successes, real alert data parsed
2026-10-09T03:38Z  last successful response
2026-10-09T04:00Z  every request since -> 401, no recovery
```

Please note the successes were never 100% of minutes even while the key was
valid (typically 35–40% of cycles). We would also like to understand that.

## Anomaly we cannot explain

With the same key in the same cycle, sometimes minutes apart:

```
GET /api/v3/alerts/status  -> 200   (response time 638 ms)
GET /api/v3/alerts         -> 401   (response time 18 ms)
```

`/api/v3/alerts/status` intermittently returns 200 while `/api/v3/alerts`
returns 401 every time it is called. Both requests are built by the same code
path with the same header. If the two endpoints are backed by different key
stores, different authorizers, or different rate-limit policies, that would
explain it — but we cannot verify this from outside.

Cloudflare ray IDs from the rejected requests, for your logs:

```
a481aafc79e3d5f5-CDG   a481a98539c3d5f5-CDG
a481a80e9e61d3d5f5-CDG   a481a696dd14d5f5-CDG
a481a51fbdf7d5f5-CDG   a481a3a8df82d5f5-CDG
a481a232494cd5f5-CDG   a481a0bd6fc0d5f5-CDG
```

## What we are asking

1. Is the key active, expired, revoked, or over quota? If over quota, when does
   it reset, and is the quota measured per key or per account?
2. Why does a 401 carry no body and no `WWW-Authenticate`, while a 429 is
   documented with `Retry-After`? Could rejection reasons be returned so clients
   can tell a bad key from an exhausted quota?
3. Why can `/api/v3/alerts/status` still return 200 with the same key while
   `/api/v3/alerts` always returns 401?
4. Is one key permitted for two projects, and are the documented rate limits per
   key or per account?

## Operational notes

We are a public alerting aggregator for Ukraine. Until this is resolved the
service reports the official source as offline rather than showing an all-clear,
so nothing is presented to the public as verified official data that is not.
That is deliberate: we would rather show a gap than fabricate an all-clear.

If the fastest resolution is to reissue the key, we will redeploy immediately —
the integration is complete, tested, and working against real data as recently
as 2026-10-09.

Thank you.
