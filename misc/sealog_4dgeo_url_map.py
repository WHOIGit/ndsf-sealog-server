#!/usr/bin/env python3
'''
FILE:           sealog_4dgeo_url_map.py

DESCRIPTION:    Map legacy 4dgeo DAQ framegrab URLs onto the equivalent
                sealog-server image URLs.

                Legacy 4dgeo URLs look like:
                  https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg

                Sealog serves framegrabs from the IMAGE_ROUTE ("/files/images")
                using the path stored in the "filename" field of each
                vehicleRealtimeFramegrabberData aux data record, i.e.:
                  https://seaplay.whoi.edu/sealog-jason/files/images/Jason-J2-1451/SubSea1.framegrab01/SubSea1.framegrab01.20230811_202030123.jpg

                The two names carry the same information except for three
                pieces that only the sealog database knows:
                  1. the lowering the timestamp falls within
                  2. the sealog camera name behind "Src<N>"
                  3. the milliseconds in the sealog framegrab timestamp

                This script resolves all three against the sealog API. The
                "Images####" bucket in the 4dgeo path is a directory bucket
                only and carries no information needed for the match.

BUGS:
NOTES:          A 4dgeo image only has a sealog counterpart if a sealog event
                (including ASNAP events) fired near its timestamp. Use
                --tolerance to control how far the match is allowed to snap.
AUTHOR:     Nathan Figueroa
COMPANY:    Woods Hole Oceanographic Institution
VERSION:    0.1
CREATED:    2026-08-05
REVISION:

LICENSE INFO:   This code is licensed under MIT license (see LICENSE.txt for details)
                Copyright (C) OceanDataTools.org 2021
'''

import bisect
import csv
import json
import logging
import re
import sys

from datetime import datetime, timedelta, timezone

from python_sealog.cruises import get_cruise_by_id
from python_sealog.lowerings import get_lowerings, get_lowerings_by_cruise
from python_sealog.misc import get_framegrab_list_by_lowering
from python_sealog.settings import API_SERVER_URL

IMAGE_ROUTE = '/files/images'

# https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg
FOURDGEO_URL_RE = re.compile(
    r'^(?:(?P<scheme>https?)://(?P<host>[^/]+))?'
    r'/?(?P<root>[^/]+)/(?P<cruise>[^/]+)/(?P<vehicle>[^/]+)/'
    r'Src(?P<src>\d+)/(?P<bucket>[^/]+)/'
    r'(?P<camera>.+?)\.(?P<date>\d{8})_(?P<time>\d{6})\.(?P<ext>jpe?g|png)$',
    re.IGNORECASE
)

# Jason-J2-1451/SubSea1.framegrab01/SubSea1.framegrab01.20230811_202030123.jpg
SEALOG_FRAMEGRAB_RE = re.compile(
    r'^/?(?P<lowering_dir>[^/]+)/(?P<camera_dir>[^/]+)/'
    r'(?P<camera>.+?)\.framegrab(?P<src>\d+)\.'
    r'(?P<date>\d{8})_(?P<time>\d{6})(?P<msec>\d{3})?\.(?P<ext>jpe?g|png)$',
    re.IGNORECASE
)


def parse_4dgeo_url(url):
    '''
    Parse a legacy 4dgeo framegrab URL into its component parts. Returns None
    if the url does not match the expected 4dgeo layout.
    '''

    match = FOURDGEO_URL_RE.match(url.strip())

    if not match:
        return None

    return {
        'cruise': match.group('cruise'),
        'vehicle': match.group('vehicle'),
        'src': int(match.group('src')),
        'camera': match.group('camera'),
        'ts': datetime.strptime(match.group('date') + match.group('time'), '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
    }


def parse_sealog_framegrab(filename):
    '''
    Parse a sealog framegrab filename (the data_value of a
    vehicleRealtimeFramegrabberData "filename" record) into its component
    parts. Returns None if the filename does not match the expected layout.
    '''

    match = SEALOG_FRAMEGRAB_RE.match(filename.strip())

    if not match:
        return None

    ts = datetime.strptime(match.group('date') + match.group('time'), '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)

    if match.group('msec'):
        ts += timedelta(milliseconds=int(match.group('msec')))

    return {
        'filename': filename,
        'lowering_dir': match.group('lowering_dir'),
        'camera': match.group('camera'),
        'src': int(match.group('src')),
        'ts': ts
    }


def sealog_image_url(filename, api_server_url=API_SERVER_URL):
    '''
    Build the publicly servable sealog URL for the given framegrab filename.
    '''

    return api_server_url.rstrip('/') + IMAGE_ROUTE + '/' + filename.lstrip('/')


def _parse_ts(value):
    '''
    Parse an ISO8601 timestamp from a sealog record into a tz-aware datetime.
    '''

    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def get_lowering_by_ts(ts, cruise_id=None):
    '''
    Return the lowering record whose start_ts/stop_ts bracket the given
    timestamp. Optionally restrict the search to a single cruise_id.
    '''

    if cruise_id:
        cruise = get_cruise_by_id(cruise_id)

        if not cruise:
            logging.warning("No cruise record found for cruise_id: %s", cruise_id)
            return None

        lowerings = get_lowerings_by_cruise(cruise['id']) or []

    else:
        lowerings = get_lowerings() or []

    for lowering in lowerings:
        if not lowering.get('start_ts') or not lowering.get('stop_ts'):
            continue

        if _parse_ts(lowering['start_ts']) <= ts <= _parse_ts(lowering['stop_ts']):
            return lowering

    return None


def build_framegrab_index(lowering_uid):
    '''
    Build a per-framegrabber, time-sorted index of the framegrabs recorded for
    the given lowering. Returns a dict keyed on the framegrabber number, each
    value a tuple of (sorted list of timestamps, matching list of records).
    '''

    by_src = {}

    for filename in get_framegrab_list_by_lowering(lowering_uid):
        framegrab = parse_sealog_framegrab(filename)

        if not framegrab:
            logging.warning("Could not parse framegrab filename: %s", filename)
            continue

        by_src.setdefault(framegrab['src'], []).append(framegrab)

    index = {}

    for src, framegrabs in by_src.items():
        framegrabs.sort(key=lambda framegrab: framegrab['ts'])
        index[src] = ([framegrab['ts'] for framegrab in framegrabs], framegrabs)

    return index


def find_nearest(index, src, ts, tolerance=1.0):
    '''
    Return the framegrab record from the index for the given framegrabber
    number that is closest in time to ts, so long as it falls within tolerance
    seconds. Returns None when there is no framegrab close enough.
    '''

    if src not in index:
        return None

    timestamps, framegrabs = index[src]
    pos = bisect.bisect_left(timestamps, ts)

    candidates = []

    if pos < len(timestamps):
        candidates.append(framegrabs[pos])

    if pos > 0:
        candidates.append(framegrabs[pos - 1])

    if not candidates:
        return None

    nearest = min(candidates, key=lambda framegrab: abs((framegrab['ts'] - ts).total_seconds()))

    if abs((nearest['ts'] - ts).total_seconds()) > tolerance:
        return None

    return nearest


def map_4dgeo_url(url, tolerance=1.0, cruise_id=None, api_server_url=API_SERVER_URL, index_cache=None):
    '''
    Map a single legacy 4dgeo framegrab URL onto its sealog equivalent.
    Returns a dict describing the match, including a 'sealog_url' key that is
    None when no match could be made.
    '''

    parsed = parse_4dgeo_url(url)

    if not parsed:
        return { 'url': url, 'sealog_url': None, 'error': 'not a 4dgeo framegrab url' }

    result = {
        'url': url,
        'ts': parsed['ts'].isoformat(),
        'src': parsed['src'],
        'sealog_url': None
    }

    lowering = get_lowering_by_ts(parsed['ts'], cruise_id=cruise_id or parsed['cruise'])

    # The 4dgeo path segment is the vessel cruise name (i.e. "tn422"), which
    # may not be the sealog cruise_id. Fall back to searching all lowerings.
    if not lowering and not cruise_id:
        lowering = get_lowering_by_ts(parsed['ts'])

    if not lowering:
        result['error'] = 'no lowering covers ' + parsed['ts'].isoformat()
        return result

    result['lowering_id'] = lowering['lowering_id']

    if index_cache is None:
        index_cache = {}

    if lowering['id'] not in index_cache:
        index_cache[lowering['id']] = build_framegrab_index(lowering['id'])

    nearest = find_nearest(index_cache[lowering['id']], parsed['src'], parsed['ts'], tolerance=tolerance)

    if not nearest:
        result['error'] = 'no framegrab for Src%d within %gs' % (parsed['src'], tolerance)
        return result

    result['sealog_path'] = nearest['filename']
    result['sealog_url'] = sealog_image_url(nearest['filename'], api_server_url=api_server_url)
    result['offset_secs'] = round((nearest['ts'] - parsed['ts']).total_seconds(), 3)

    return result


def _lowerings_for_cruise(cruise_id):
    '''
    Return the lowering records for the given cruise_id.
    '''

    cruise = get_cruise_by_id(cruise_id)

    if not cruise:
        logging.error("No cruise record found for cruise_id: %s", cruise_id)
        return []

    return get_lowerings_by_cruise(cruise['id']) or []


def build_manifest(lowerings, api_server_url=API_SERVER_URL):
    '''
    Build the full list of framegrab records for the given lowerings, each
    annotated with the whole-second lookup key a legacy 4dgeo URL reduces to.
    '''

    manifest = []

    for lowering in lowerings:
        logging.info("Indexing framegrabs for lowering: %s", lowering['lowering_id'])
        index = build_framegrab_index(lowering['id'])

        for src, (_, framegrabs) in sorted(index.items()):
            for framegrab in framegrabs:
                manifest.append({
                    'key': 'Src%d/%s' % (src, framegrab['ts'].strftime('%Y%m%d_%H%M%S')),
                    'lowering_id': lowering['lowering_id'],
                    'src': src,
                    'camera': framegrab['camera'],
                    'ts': framegrab['ts'].isoformat(),
                    'sealog_path': framegrab['filename'],
                    'sealog_url': sealog_image_url(framegrab['filename'], api_server_url=api_server_url)
                })

    manifest.sort(key=lambda record: record['key'])

    return manifest


def write_manifest_csv(manifest, output_file):
    '''
    Write the manifest to output_file in csv format.
    '''

    fieldnames = ['key', 'lowering_id', 'src', 'camera', 'ts', 'sealog_path', 'sealog_url']

    with open(output_file, 'w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(manifest)


def write_nginx_map(manifest, output_file):
    '''
    Write the manifest as an nginx map block keyed on "Src<N>/<YYYYMMDD>_<HHMMSS>".

    Pair it with a location block that normalizes the legacy request, i.e.:

      map $fourdgeo_key $sealog_framegrab {
          default "";
          include /etc/nginx/4dgeo_framegrabs.map;
      }

      location ~ ^/DAQ/[^/]+/[^/]+/(?<src>Src\\d+)/[^/]+/.+\\.(?<fgts>\\d{8}_\\d{6})\\.jpe?g$ {
          set $fourdgeo_key "$src/$fgts";
          if ($sealog_framegrab = "") { return 404; }
          return 301 $sealog_framegrab;
      }
    '''

    with open(output_file, 'w') as file:
        for record in manifest:
            file.write('"%s" "%s";\n' % (record['key'], record['sealog_url']))


if __name__ == '__main__':

    import argparse
    import os

    parser = argparse.ArgumentParser(description='Map legacy 4dgeo framegrab URLs to sealog image URLs.')
    parser.add_argument('-v', '--verbosity', dest='verbosity',
                                            default=0, action='count',
                                            help='Increase output verbosity')
    parser.add_argument('-c', '--cruise', dest='cruise_id',
                                          help='Restrict the lookup to this sealog cruise_id, or build the manifest for it.')
    parser.add_argument('-l', '--lowering', dest='lowering_id',
                                            help='Build the manifest for this sealog lowering_id.')
    parser.add_argument('-t', '--tolerance', type=float, default=1.0,
                                             help='Max seconds a 4dgeo timestamp may be from a sealog framegrab (default: 1.0)')
    parser.add_argument('-u', '--sealog-url', dest='api_server_url', default=API_SERVER_URL,
                                              help='Base url sealog is served from (default: %s)' % API_SERVER_URL)
    parser.add_argument('-m', '--manifest', dest='manifest_file',
                                            help='Write the full old-key/new-url manifest to this csv file.')
    parser.add_argument('-n', '--nginx-map', dest='nginx_map_file',
                                             help='Write the full mapping to this file as an nginx map block.')
    parser.add_argument('urls', nargs='*', help='4dgeo url(s) to map. Use "-" to read urls from stdin.')

    parsed_args = parser.parse_args()

    ############################
    # Set up logging before we do any other argument parsing (so that we
    # can log problems with argument parsing).

    LOGGING_FORMAT = '%(asctime)-15s %(levelname)s - %(message)s'
    logging.basicConfig(format=LOGGING_FORMAT)

    LOG_LEVELS = {0: logging.WARNING, 1: logging.INFO, 2: logging.DEBUG}
    parsed_args.verbosity = min(parsed_args.verbosity, max(LOG_LEVELS))
    logging.getLogger().setLevel(LOG_LEVELS[parsed_args.verbosity])

    try:
        if parsed_args.manifest_file or parsed_args.nginx_map_file:

            if parsed_args.lowering_id:
                from python_sealog.lowerings import get_lowering_by_id
                LOWERING = get_lowering_by_id(parsed_args.lowering_id)
                LOWERINGS = [LOWERING] if LOWERING else []

            elif parsed_args.cruise_id:
                LOWERINGS = _lowerings_for_cruise(parsed_args.cruise_id)

            else:
                LOWERINGS = get_lowerings() or []

            if not LOWERINGS:
                logging.error('No lowerings found to build a manifest from')
                sys.exit(1)

            MANIFEST = build_manifest(LOWERINGS, api_server_url=parsed_args.api_server_url)
            logging.info('Mapped %d framegrabs', len(MANIFEST))

            if parsed_args.manifest_file:
                write_manifest_csv(MANIFEST, parsed_args.manifest_file)

            if parsed_args.nginx_map_file:
                write_nginx_map(MANIFEST, parsed_args.nginx_map_file)

        if parsed_args.urls:
            URLS = sys.stdin.read().splitlines() if parsed_args.urls == ['-'] else parsed_args.urls
            INDEX_CACHE = {}
            RESULTS = []

            for url in URLS:
                if not url.strip():
                    continue

                RESULTS.append(map_4dgeo_url(url,
                                             tolerance=parsed_args.tolerance,
                                             cruise_id=parsed_args.cruise_id,
                                             api_server_url=parsed_args.api_server_url,
                                             index_cache=INDEX_CACHE))

            print(json.dumps(RESULTS, indent=2))

            if any(result['sealog_url'] is None for result in RESULTS):
                sys.exit(1)

        elif not (parsed_args.manifest_file or parsed_args.nginx_map_file):
            parser.print_help()
            sys.exit(1)

    except KeyboardInterrupt:
        logging.warning('Interrupted')
        try:
            sys.exit(0)
        except SystemExit:
            os._exit(0) # pylint: disable=protected-access
