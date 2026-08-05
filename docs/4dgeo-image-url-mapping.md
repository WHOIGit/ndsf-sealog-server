## Mapping legacy 4dgeo framegrab URLs to Sealog

This describes how to re-point the legacy 4dgeo DAQ image URLs at Sealog so the
old host can be sunset, and what `misc/sealog_4dgeo_url_map.py` does.

### The two URL formats

Legacy 4dgeo:

```
https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg
                            |      |     |    |         |       |
                            |      |     |    |         |       `- UTC timestamp, whole seconds
                            |      |     |    |         `--------- DAQ camera label
                            |      |     |    `------------------- directory bucket (no information)
                            |      |     `------------------------ framegrabber number
                            |      `------------------------------ vehicle
                            `------------------------------------- vessel cruise name
```

Sealog:

```
https://<sealog_host>/files/images/Jason-J2-1451/SubSea1.framegrab01/SubSea1.framegrab01.20230811_202030123.jpg
                     |             |             |                   |       |           |
                     |             |             |                   |       |           `- UTC timestamp, milliseconds
                     |             |             |                   |       `------------- framegrabber number
                     |             |             |                   `--------------------- sealog camera name
                     |             |             `----------------------------------------- camera subdirectory
                     |             `------------------------------------------------------- <vehicle>-<lowering_id>
                     `--------------------------------------------------------------------- IMAGE_ROUTE (routes/default.js)
```

The Sealog half of the path is not synthesized by the server. It is the
`filename` value stored in each `vehicleRealtimeFramegrabberData` aux data
record (see `misc/python_sealog/misc.py` and the fixture in
`test/routes.api.v1.json_util.test.js`), served verbatim under `IMAGE_ROUTE`
(`/files/images`) from `IMAGE_PATH`. That route has its `jwt` auth block
commented out in `routes/default.js`, so framegrabs are already served
unauthenticated — a plain redirect from the old host will work.

### Why there is no pure string rewrite

The two names carry the same information except for three pieces that only the
Sealog database knows:

1. **The lowering.** The 4dgeo path has the cruise (`tn422`) but no dive
   number, while Sealog keys its image directory on `<vehicle>-<lowering_id>`.
   Resolving it is a timestamp-in-range lookup against
   `start_ts`/`stop_ts` on the lowering records.
2. **The camera name.** `Src1` maps to `framegrab01`, but the leading
   `SubSea1` in the 4dgeo filename is the DAQ label, not necessarily the Sealog
   `camera_name`. The framegrabber number is the reliable join key — Sealog
   embeds it in both the camera subdirectory and the filename, and also spells
   it out in the paired `camera_name` value (`port_brow_4k (Framegrabber 1)`).
3. **The milliseconds.** 4dgeo names are whole-second; Sealog framegrab names
   carry milliseconds, taken from the `ts` of the event that triggered the
   grab. There is no way to recover those three digits from the old URL.

So the mapping is a lookup, not a formula. The good news is that the lookup key
is small: **framegrabber number plus whole-second UTC timestamp** is enough.
Everything else in the old URL (`DAQ`, cruise, vehicle, `Images####` bucket,
camera label) can be discarded.

### The mapping

```
Src<N>/<YYYYMMDD>_<HHMMSS>  ->  <sealog_host>/files/images/<filename from aux data>
```

Note that the two systems capture on different schedules. Sealog only has a
framegrab where an event fired (including ASNAP events, typically every 10s),
whereas the DAQ wrote images on its own cadence. **Expect the old host to hold
more images than Sealog can serve back.** Anything without a match inside the
tolerance has no Sealog equivalent and should 404 rather than redirect to a
neighbouring frame.

### Using the script

Translate one or more URLs (prints JSON, exits non-zero if any URL failed to
map):

```
cd ~/sealog-server/misc
./sealog_4dgeo_url_map.py -u https://seaplay.whoi.edu/sealog-jason \
  https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg
```

Check coverage over a large sample before committing to the sunset:

```
./sealog_4dgeo_url_map.py -u https://seaplay.whoi.edu/sealog-jason - < 4dgeo_urls.txt > mapped.json
```

Build the full old-key/new-url table for a cruise, and the matching nginx map
file:

```
./sealog_4dgeo_url_map.py -c TN422 -u https://seaplay.whoi.edu/sealog-jason \
  -m tn422_framegrabs.csv -n tn422_framegrabs.map
```

`--tolerance` (default 1.0s) controls how far a 4dgeo timestamp may be from a
Sealog framegrab before the match is rejected. Keep it at or below 1s for a
faithful mapping; raise it only if you would rather serve the nearest frame
than a 404.

### Redirecting at the old host

The generated `.map` file is keyed on the normalized lookup key, so nginx can
do the rewrite without knowing anything about lowerings:

```nginx
map $fourdgeo_key $sealog_framegrab {
    default "";
    include /etc/nginx/4dgeo_framegrabs.map;
}

location ~ ^/DAQ/[^/]+/[^/]+/(?<src>Src\d+)/[^/]+/.+\.(?<fgts>\d{8}_\d{6})\.jpe?g$ {
    set $fourdgeo_key "$src/$fgts";
    if ($sealog_framegrab = "") { return 404; }
    return 301 $sealog_framegrab;
}
```

### Before you rely on this

Two things need confirming against the live hosts, which the script will tell
you on the first run:

- The public base URL Sealog is served from (the `-u` value). `IMAGE_ROUTE` is
  `/files/images` relative to the server root, so the prefix depends on how
  seaplay proxies `sealog-jason`.
- That Jason's Sealog `camera_name` framegrabber numbers line up with the DAQ's
  `Src<N>`. Dump one lowering with `-m` and compare the `src`/`camera` columns
  against the `Src<N>` directories on 4dgeo for the same dive.
