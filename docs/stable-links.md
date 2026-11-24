## Stable links

Sealog's own URLs are not predictable from the outside. Client pages are keyed by
database id (`/lowering_gallery/67aa0b8ed76c52001ae3ae43`), and framegrab files are
named after the millisecond timestamp of the event that captured them
(`port_brow_4k.framegrab01.20250210_183242956.jpg`), so a link built from a dive
name and a whole-second time 404s.

The `/links` routes give outside systems (such as 4DGeo and marine-geo.org) URLs
built only from names they already have. They redirect to the real page or file.

### A lowering

```
GET <server>/links/lowerings/{lowering_id}[?view=gallery|map|replay]
```

Redirects to that view of the lowering in the Sealog client. The client's base URL
comes from the `SEALOG_CLIENT_URL` environment variable, for example
`https://seaplay.whoi.edu/sealog-alvin`. Without it, or with `?format=json`, the
route returns the lowering's id and client path as JSON instead.

### A framegrab

```
GET <server>/links/images/{lowering_id}/{camera}/{timestamp}[?tolerance=30]
```

Redirects to the framegrab from `camera` nearest to `timestamp` within the lowering.

- `timestamp` is `YYYYMMDD_HHMMSS`, `YYYYMMDD_HHMMSSmmm` or ISO 8601, in UTC.
- `camera` can be the camera name (`port_brow_4k`, `SciCam`), its image directory
  (`port_brow_4k.framegrab01`) or its full `camera_name`
  (`port_brow_4k (Framegrabber 1)`), case-insensitively.
- `tolerance` is how many seconds either side to search (default 30, max 600).
  Sealog only has a frame where an event fired (ASNAP every 10 to 30 s, depending on
  the year), so a requested time usually lands between frames.
- `?format=json` returns the match instead of redirecting, including
  `delta_seconds`, the signed offset of the frame from the requested time.

The redirect is relative to the route, so it works behind any reverse-proxy prefix.
Example:

```
https://seaplay.whoi.edu/sealog-alvin/server/links/images/Alvin-D5295/port_brow_4k/20250210_183242
  -> https://seaplay.whoi.edu/sealog-alvin/server/files/images/Alvin-D5295/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20250210_183242956.jpg
```

### Access

Both routes follow the same rules as the lowerings API: public lowerings need no
token, and hidden lowerings (or lowerings in a hidden cruise) need an authorized user.
The image files themselves are served without authentication, as before.

### Deploying

Deployments that mount their own `config/manifest.js` need the `./routes/links`
plugin added to it, as in `config/manifest.js.dist`.
