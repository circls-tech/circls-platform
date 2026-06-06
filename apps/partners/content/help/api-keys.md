circls offers a REST API and outbound webhooks so aggregators and your own systems can read and write data and stay in sync in real time. Manage both under **Settings**.

## The aggregator API at a glance

- **Base path:** the aggregator API lives under `/api/v1/*` and is authenticated with a circls **API key**.
- **Authentication:** send your key as a bearer token — `Authorization: Bearer ck_…`.
- (The portal's own `/v1/*` endpoints use Firebase auth and are separate from the API-key API.)

## API keys

### Generating a key

1. Go to **Settings → API keys**.
2. In **Create a key**, enter a **Name** (e.g. *PartnerCo aggregator*) and pick a **role**:
   - **read** — read-only access (GET).
   - **write** — read plus create/update/delete.
   - **admin** — full access.
3. Click **Generate key**.

The full key is shown **once**, in a reveal panel. Keys look like `ck_test_…` (test) or `ck_live_…` (production). **Copy it immediately and store it securely** — it can't be retrieved again after you leave the page. If you lose it, revoke it and generate a new one.

### Using a key

Send the key as a bearer token on every request:

```bash
curl -H "Authorization: Bearer ck_live_xxxxxxxxxxxxxxxxxxxxxxxx" \
  https://api.circls.app/api/v1/...
```

### Revoking a key

In **Existing keys**, click **Revoke** next to a key and confirm. Revocation is immediate and permanent — any integration still using that key starts receiving `401 Unauthorized` straight away. Rotate keys by generating a new one, switching your integration over, then revoking the old one.

## Outbound webhooks

Webhooks push events to a URL you control the moment they happen, so you don't have to poll.

### Creating a subscription

1. Go to **Settings → Outbound webhooks**.
2. In **Create a subscription**, enter your **Delivery URL** (e.g. `https://example.com/webhooks/circls`).
3. Select the **events** to subscribe to:
   - `booking.confirmed`
   - `booking.cancelled`
   - `payment.captured`
   - `payment.refunded`
4. Click **Create subscription**.

A **signing secret** is shown once — copy it now; it's never shown again. Use it to verify incoming deliveries (below).

### Verifying deliveries

Each delivery carries an `X-Circls-Signature` header of the form:

```
X-Circls-Signature: t=<unix-ms-timestamp>,v1=<hex-digest>
```

To verify a delivery:

1. Read `t` and `v1` from the header.
2. Compute `HMAC-SHA256` of the string `` `${t}.${rawBody}` `` using your signing secret — over the **raw request body**, before any JSON parsing.
3. Compare your hex digest to `v1` using a constant-time comparison.
4. Reject the delivery if `t` is more than ~5 minutes from the current time (replay protection).

Example in Node.js:

```js
const crypto = require('crypto');

function verifyWebhook(rawBody, signatureHeader, secret, toleranceMs = 5 * 60 * 1000) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() - t) > toleranceMs) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

### Inspecting and removing subscriptions

- **Deliveries** — view recent delivery attempts for a subscription, with their event type, status, attempt count and any error. Failed deliveries are retried.
- **Delete** — remove a subscription; any pending deliveries to it are discarded.

## Tips

- Use a **test** key (`ck_test_…`) while developing and a **live** key (`ck_live_…`) in production.
- Always verify the `X-Circls-Signature` before trusting a webhook payload, and respond quickly with a `2xx` so deliveries aren't retried unnecessarily.
- Treat keys and signing secrets like passwords — never commit them to source control.
