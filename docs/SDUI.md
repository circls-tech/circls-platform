# Server-driven UI (SDUI)

The mobile apps (consumer, partners) fetch screen layouts from the API and
render them, so a layout change ships without an app-store review. The
Flutter side owns the renderer; this repo owns storage, the contract, the
public and admin routes, and the admin portal's **Screens** page.

## The screen document

```
Screen    = { schemaVersion: 1,
              screen: "<app>.<key>",          // must match the route it is saved under
              version?: number,               // server-assigned; whatever a client sends is ignored
              minBuild?: { ios?: n, android?: n, "*"?: n },
              meta?: object,
              root: Node }
Node      = { type: string, id?: string, props?: object, children?: Node[],
              visible?: Condition, onTap?: Action }
Action    = { type: string, ...anything }     // {"type":"navigate","route":"/events"},
                                              // {"type":"sequence","actions":[...]}
Condition = { flag?: string, signedIn?: bool, platform?: "ios"|"android",
              minBuild?: int, maxBuild?: int, after?: ISO date, before?: ISO date,
              eq?: [any, any], nonEmpty?: any, truthy?: any,
              not?: Condition, all?: Condition[], any?: Condition[] }
```

Several keys in one Condition are AND-ed. Unknown Condition keys, unknown
Node keys and unknown top-level Screen keys are rejected; node `type` names
are **not** validated — an app ignores a type it doesn't know, so a layout
may use a widget only a newer build has (gate it with `minBuild`). Limits:
32 levels of nesting, 256 KB of JSON. The zod schema and TS types live in
`apps/api/src/lib/sdui/schema.ts`.

## Versions, status, minBuild

Table `screen_layouts`, one row per `(app, key, version)`:

- `version` is monotonic per screen. The single **draft** row holds the next
  number; **publish** flips it to `published` (moving it past any newer
  version a rollback created meanwhile). Older published rows stay
  `published` — the highest version a client may render wins — and beyond
  the newest five they are marked `archived`. **Rollback** copies an old
  version's body into a *new* published row, so history is append-only.
- `min_build` (`{"ios": 12, "android": 12}`, `"*"` for all) is the lowest
  app build that may render the row. A client sends `?platform=ios&build=12`
  and gets the highest published version whose `min_build` it satisfies and
  whose `schema_version` ≤ its `?schema=` (default 1). No `build` (a curl)
  means nothing is gated.
- Feature flags are a `{name: bool}` map in `platform_settings` under
  `sdui.flags.<app>`; the update notice under `sdui.update.<app>`
  (`{"minSupportedBuild": {"ios": n, "android": n}, "message": {"title", "body", "url"}}`).

## Routes

Public (rate-limited like the consumer browse routes, no auth):

| Route | Returns |
|---|---|
| `GET /v1/screens/:app/manifest?platform=&build=` | `{ app, flags, screens: { [key]: { version } }, update, generatedAt }` |
| `GET /v1/screens/:app/:key?platform=&build=&schema=` | the Screen (with `version`, `minBuild` filled from the row); 404 `not_found` when nothing is renderable |
| `GET /v1/screens/:app/:key?draft=1` + Bearer | the draft, for a Circls admin (`admin.content.read`) — the app's debug "SDUI preview" setting |

Screen responses carry `ETag: "<app>.<key>.<version>"` (honouring
`If-None-Match` with a 304) and `Cache-Control: public, max-age=60,
stale-while-revalidate=300`; the draft is `no-store`. The API keeps a 15s
in-process cache per app that every publish/rollback/flag change drops, so
a change reaches apps within about a minute.

Admin (Bearer, Circls tenant member; reads need `admin.content.read`
(every platform role), writes `admin.content.write` (Owner, Manager); every
write is audited):

| Route | Body |
|---|---|
| `GET /v1/admin/screens?app=` | — → `{ screens: [{ app, key, publishedVersion, draftVersion, updatedAt }] }` |
| `GET /v1/admin/screens/:app/:key` | — → `{ published, draft, history }` (history without bodies) |
| `GET /v1/admin/screens/:app/:key/versions/:version` | — → the row with its body |
| `PUT /v1/admin/screens/:app/:key/draft` | `{ body: Screen, minBuild?, note? }` → the draft row |
| `DELETE /v1/admin/screens/:app/:key/draft` | — |
| `POST /v1/admin/screens/:app/:key/publish` | — (409 `no_draft`) |
| `POST /v1/admin/screens/:app/:key/rollback` | `{ version }` |
| `GET` / `PUT /v1/admin/screens/:app/flags` | `{ flags: { name: bool } }` (replaces the map) |
| `GET` / `PUT /v1/admin/screens/:app/update` | the notice, or `{ update: null }` / `null` to clear |

`app` is `consumer` or `partners`; `key` matches `[a-z0-9_]{1,64}` and is
not `manifest`, `flags` or `update`. A validation failure is a 400
`invalid_screen` with `details.issues` (path + message).

## Seeding from the Flutter repo

The apps bundle a fallback copy of each screen at
`/Users/vedant/personal/circls/apps/{consumer,partners}/assets/sdui/*.json`
(file name = screen key). To seed or update the server from them:

```sh
TOKEN=<firebase id token of a Circls Owner/Manager>   # the admin portal's session token works
for f in /Users/vedant/personal/circls/apps/consumer/assets/sdui/*.json; do
  node scripts/sdui/publish.mjs --api https://api.circls.app --token "$TOKEN" \
    --app consumer --key "$(basename "$f" .json)" --file "$f" --publish --min-build ios=12,android=12
done
```

Without `--publish` the script only saves the draft, which you can then
preview on a device (`?draft=1`) and publish from the admin portal.

## Deploying

The API and the admin portal deploy from the **`release`** branch (Coolify
watches it); merging to `main` alone does not ship migration 0078 or the
routes. Migrations run on deploy (`migrate:prod`).
