## Mapping 4dgeo framegrab URLs to Sealog framegrab URLs

Background for retiring the 4dgeo image host and re-pointing its links at Sealog.

**Short answer: there is no string-to-string formula.** A Sealog image URL cannot be
computed from a 4dgeo one, because the Sealog filename carries information the 4dgeo
filename does not have. The mapping has to be resolved against the Sealog API. That
resolution *is* mechanical and can be batched — see
[`misc/sealog_4dgeo_image_map.py`](../misc/sealog_4dgeo_image_map.py).

### Anatomy of the two URLs

4dgeo:

```
https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg
                            └cruise┘ └veh┘ └src┘        └pfx─┘ └─date─┘ └time┘
```

Sealog:

```
https://seaplay.whoi.edu/sealog-jason/server/files/images/J2-1558/PilotCam/PilotCam..20230916_125548673.jpg
        └──────── API_SERVER_URL ────────────┘└IMAGE_ROUTE┘└low_id┘└camera┘ └camera┘│└─date─┘ └─time──┘
                                                                                    └ framegrabber label
```

Everything after `/files/images` is the `filename` value stored verbatim in the
`vehicleRealtimeFramegrabberData` aux-data record for a Sealog event. The image route
itself is unauthenticated (`routes/default.js`), so any resolved URL is publicly
fetchable even when the dive's *metadata* is embargoed.

### Why a formula does not exist

Five independent gaps, in rough order of how much trouble each causes:

1. **The millisecond field cannot be guessed.** Sealog names each framegrab after the
   millisecond-precision `ts` of the event it was captured for. Across all 3140
   framegrab filenames in J2-1511, the filename timestamp equals the event `ts` exactly
   — 0 mismatches — and the milliseconds are effectively random: 530 distinct values
   over 785 events, never `000`. The server does no rounding, and the images directory
   returns `403` rather than a listing, so `..._125548000.jpg` and any other guess is a
   `404`.

2. **The dive number is not in the 4dgeo path.** 4dgeo organizes by *cruise*
   (`tn422`); Sealog organizes by *lowering* (`J2-1558`). One cruise is dozens of
   dives. Recovering the dive means a timestamp lookup against the lowering windows.

3. **The two systems capture on independent schedules.** Sealog only holds a framegrab
   where a Sealog *event* exists — ASNAP plus operator-logged events. The ASNAP interval
   has changed over the years (10 s in 2019–2021, 30 s in 2022–2023, 15 s in
   2024–present), and it is switched off outside dives and during some on-bottom
   periods (J2-1511 has a 94-minute gap). The 4dgeo DAQ writes on its own cadence. So an
   arbitrary 4dgeo frame usually has *no* Sealog frame at the same second — only a
   nearby one.

4. **Camera naming differs and is not stable.** 4dgeo uses DAQ source slots
   (`Src1`/`SubSea1`); Sealog uses camera names, and the roster has changed:
   `SciCam, PilotCam, BrowCam, MedeaCam` (2019) → `…, AftCam` (2020–2021) →
   `SciCam, PilotCam, BrowCam, UserSelect` (2022–present). Which `Src<n>` fed which
   camera is per-cruise DAQ configuration and is not derivable from either path.

5. **The Sealog filename template itself changed.** Older dives are
   `SciCam.20220727_192607028.jpg`; from the following cruise on they are
   `SciCam..20230708_232317781.jpg` — an extra framegrabber-label field that Jason
   leaves empty and Alvin fills in (`port_brow_4k.framegrab01.20230127_154439513.jpg`).
   The changeover falls between J2-1437 (2022-07-27) and J2-1442 (2022-09-20). Any
   hard-coded template silently breaks on one side of that boundary.

Not every 4dgeo frame has a counterpart at all. The example
`.../DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg` is one of them:
2023-08-11 20:20:30Z falls in no lowering. Sealog has TN422 running 2023-08-13 →
2023-09-18 with its first dive J2-1512 on 08-14, and the previous dive J2-1511 ended
2023-08-07 03:00Z. The DAQ was recording during the port/transit period between
cruises, which Sealog has no dive for.

### The lookup that does work

```
4dgeo URL
  └─ parse ──────────────────► cruise, Src<n>, YYYYMMDD_HHMMSS (UTC)
       └─ GET /api/v1/lowerings?startTS=<ts>&stopTS=<ts+1ms>
            └────────────────► lowering uid + lowering_id     (404 = no dive covers it)
                 └─ GET /api/v1/event_exports/bylowering/<uid>?datasource=vehicleRealtimeFramegrabberData
                      └───────► [{ts, aux_data:[{camera_name, filename}]}, …]
                           └─ nearest ts within tolerance, pick camera
                                └─► API_SERVER_URL + /files/images + filename
```

Two things worth knowing about that first call. The lowering time-range query is
evaluated against the unsanitized records, so it resolves the correct `lowering_id`
even for an embargoed dive — the `start_ts`/`stop_ts` in the *response* are flattened
to date-only (`lib/access_control.js`), but the match itself is exact. The second call
does need a token for embargoed dives; it is public otherwise.

### Using the script

```bash
# single image, with the DAQ source mapped to a Sealog camera
./sealog_4dgeo_image_map.py --camera-map "Src1=SciCam" \
  https://4dgeo.whoi.edu/DAQ/tn421/Jason/Src1/Images0001/SubSea1.20230806_215813.jpg

# whole-host sweep: one CSV row per image, one API call per lowering
find /path/to/4dgeo/DAQ -name '*.jpg' | ./sealog_4dgeo_image_map.py \
  --camera-map "Src1=SciCam,Src2=PilotCam" --token "$SEALOG_TOKEN" \
  --verify > redirect_map.csv
```

Output columns: `source_url, cruise, source, ts, lowering_id, camera, sealog_url,
delta_sec, status` (plus `verified` with `--verify`, which HEADs each resolved URL).
`delta_sec` is the signed offset between the 4dgeo frame and the Sealog frame it was
matched to — it is the number to look at before trusting a row, since a match is a
*nearest neighbour*, not the same image. `--tolerance` (default 30 s) caps how far the
resolver will reach; drop it to 1–2 s if you only want near-simultaneous frames and
would rather leave the rest unmapped. Exit status is non-zero if any input failed to
resolve.

Leave a source out of `--camera-map` and the row lists every camera Sealog holds for
that event, which is a quick way to eyeball what `Src<n>` actually corresponds to
before committing to a mapping.

### Suggested approach for the sunset

Resolve once, ship a static table — don't put a live API lookup in the redirect path.
Run the sweep over the 4dgeo tree with `--verify`, then split on `status`: `matched`
rows with a small `delta_sec` become `301`s, and everything else (`no lowering covers
this timestamp`, out-of-tolerance) needs a decision — either keep those images
somewhere or let the links go. Given point 3 above, expect a meaningful fraction of
4dgeo frames to land in the second bucket; the redirect table will not be complete, and
it's worth measuring that fraction early since it may change the plan.

### Verification notes

Everything above was checked against the live `seaplay.whoi.edu/sealog-jason` API in
August 2026, mostly using J2-1511 (TN421, public) plus one sampled dive per year
2019–2025. Round-tripping real Sealog frame times through the resolver as synthetic
4dgeo URLs returns the original images and they fetch `200`.

The 4dgeo host is not reachable from outside WHOI, so two things here rest on the URL
shape alone rather than on inspection: the DAQ's own capture cadence, and the
`Src<n>` → camera correspondence. Both should be confirmed against a real 4dgeo tree
before a large sweep.
