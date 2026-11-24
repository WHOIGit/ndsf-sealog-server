## Stable links

Framegrab files are named after the millisecond timestamp of the event that
captured them (`port_brow_4k.framegrab01.20250210_183242956.jpg`), so a link built
from a dive name, a camera and a whole-second time 404s.

The `/links/images` route gives outside systems (such as 4DGeo and marine-geo.org)
image URLs built only from names they already have, and redirects to the real file.

Lowerings already have stable links: the client opens
`<client>/lowering_gallery/{lowering_id}` (and `lowering_map`, `lowering_replay`)
by name, e.g. `https://seaplay.whoi.edu/sealog-alvin/lowering_gallery/Alvin-D5295`.

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

The route follows the same rules as the lowerings API: public lowerings need no
token, and hidden lowerings (or lowerings in a hidden cruise) need an authorized user.
The image files themselves are served without authentication, as before.

### Deploying

Deployments that mount their own `config/manifest.js` need the `./routes/links`
plugin added to it, as in `config/manifest.js.dist`.
