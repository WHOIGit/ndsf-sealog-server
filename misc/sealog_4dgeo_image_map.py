#!/usr/bin/env python3
'''
FILE:           sealog_4dgeo_image_map.py

DESCRIPTION:    Map 4dgeo DAQ framegrab image URLs to the equivalent sealog
                image URLs.

                4dgeo names its framegrabs by cruise, video source and a
                whole-second timestamp:

                  https://4dgeo.whoi.edu/DAQ/tn422/Jason/Src1/Images0001/SubSea1.20230811_202030.jpg

                sealog names its framegrabs by lowering, camera and the
                millisecond-resolution timestamp of the event the framegrab
                was captured for:

                  https://seaplay.whoi.edu/sealog-jason/server/files/images/J2-1558/PilotCam/PilotCam..20230916_125548673.jpg

                There is no string-to-string formula between the two (see
                docs/4dgeo-image-mapping.md).  The lowering_id is not present
                in the 4dgeo path, the millisecond field cannot be guessed,
                the two systems capture on independent schedules and the
                sealog filename template has changed over the years.  This
                script therefore resolves the mapping against the sealog API
                instead of computing it:

                  1. cruise/timestamp -> lowering, via GET /lowerings?startTS
                  2. lowering          -> framegrab index, via GET
                                          /event_exports/bylowering
                  3. nearest framegrab event within --tolerance seconds
                  4. sealog image URL for the requested camera

BUGS:
NOTES:      4dgeo filename timestamps are assumed to be UTC, matching sealog
            event timestamps.  Use --utc-offset if a given DAQ wrote local
            time.

            The 4dgeo Src<n> -> sealog camera name mapping is a per-cruise DAQ
            configuration and is not derivable from the paths.  Supply it with
            --camera-map, or omit it to emit every camera sealog holds for the
            matched event.
AUTHOR:     Nathan Fig
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
from urllib.parse import urlparse

import requests

from python_sealog.settings import API_SERVER_URL, HEADERS, LOWERINGS_API_PATH, EVENT_EXPORTS_API_PATH

IMAGE_ROUTE = '/files/images'

FRAMEGRAB_DATA_SOURCE = 'vehicleRealtimeFramegrabberData'

# https://4dgeo.whoi.edu/DAQ/<cruise>/<vehicle>/<source>/Images<nnnn>/<prefix>.<YYYYMMDD>_<HHMMSS>.jpg
FOURDGEO_PATH_RE = re.compile(
    r'/DAQ/(?P<cruise>[^/]+)/(?P<vehicle>[^/]+)/(?P<source>[^/]+)/Images\d+/'
    r'(?P<prefix>[^/]+)\.(?P<date>\d{8})_(?P<time>\d{6})\.(?P<ext>jpe?g)$',
    re.IGNORECASE)

# Default nearest-match window.  The sealog ASNAP interval has been 10s
# (2019-2021), 30s (2022-2023) and 15s (2024-present), so 30s finds a
# neighbouring frame for every era.  Tighten it when you only want frames that
# are genuinely contemporaneous.
DEFAULT_TOLERANCE = 30.0


class ResolveError(Exception):
    '''Raised when a 4dgeo image cannot be mapped to a sealog image.'''


def parse_4dgeo_url(url):
    '''
    Parse a 4dgeo image URL (or bare path) into its component parts.  Returns a
    dict with cruise, vehicle, source, prefix and ts (a tz-aware datetime), or
    raises ResolveError if the url is not in the expected form.
    '''

    path = urlparse(url).path or url
    match = FOURDGEO_PATH_RE.search(path)

    if not match:
        raise ResolveError('not a recognized 4dgeo image path: %s' % url)

    try:
        stamp = datetime.strptime(match.group('date') + match.group('time'), '%Y%m%d%H%M%S')
    except ValueError as error:
        raise ResolveError('unparsable timestamp in %s: %s' % (url, error)) from error

    return {
        'cruise': match.group('cruise'),
        'vehicle': match.group('vehicle'),
        'source': match.group('source'),
        'prefix': match.group('prefix'),
        'ts': stamp.replace(tzinfo=timezone.utc)
    }


def parse_sealog_ts(value):
    '''
    Parse a sealog ISO-8601 timestamp into a tz-aware datetime.
    '''

    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class SealogImageResolver:
    '''
    Resolves 4dgeo image URLs to sealog image URLs.  Lowering lookups and
    per-lowering framegrab indexes are cached, so mapping a whole cruise's
    worth of images costs one API call per lowering rather than one per image.
    '''

    def __init__(self, api_server_url=API_SERVER_URL, headers=None, tolerance=DEFAULT_TOLERANCE, utc_offset=0.0):
        self.api_server_url = api_server_url.rstrip('/')
        self.headers = headers if headers is not None else HEADERS
        self.tolerance = tolerance
        self.utc_offset = utc_offset
        self._indexes = {}
        self._lowering_cache = {}

    def image_url(self, filename):
        '''
        Build the public sealog image URL for a framegrab filename as stored in
        the event_aux_data record (e.g. /J2-1511/SciCam/SciCam..2023...jpg).
        '''

        return self.api_server_url + IMAGE_ROUTE + '/' + filename.lstrip('/')

    def _get(self, path, params=None):
        '''
        Issue a GET against the sealog API.  Returns the decoded body, or None
        when the server reports there are no matching records.
        '''

        url = self.api_server_url + path
        logging.debug('GET %s %s', url, params or {})
        req = requests.get(url, headers=self.headers, params=params, timeout=120)

        if req.status_code == 404:
            return None

        if req.status_code == 401:
            raise ResolveError('not authorized for %s - the lowering is likely embargoed, supply a token' % path)

        req.raise_for_status()

        return json.loads(req.text)

    def find_lowering(self, stamp):
        '''
        Return the lowering record whose window contains the given timestamp,
        or None if the timestamp falls outside every lowering.

        Note the server evaluates this query against the unsanitized records,
        so an embargoed lowering is still matched by timestamp even though the
        start_ts/stop_ts it returns are flattened to date-only.
        '''

        for uid, index in self._indexes.items():
            if index['first'] <= stamp <= index['last']:
                return self._lowering_cache[uid]

        window_start = stamp.isoformat().replace('+00:00', 'Z')
        window_stop = (stamp + timedelta(milliseconds=1)).isoformat().replace('+00:00', 'Z')

        lowerings = self._get(LOWERINGS_API_PATH, {'startTS': window_start, 'stopTS': window_stop})

        if not lowerings:
            return None

        lowering = lowerings[0]
        self._lowering_cache[lowering['id']] = lowering

        return lowering

    def framegrab_index(self, lowering_uid):
        '''
        Return the framegrab index for a lowering: sorted event timestamps and,
        for each, a camera_name -> filename mapping.
        '''

        if lowering_uid in self._indexes:
            return self._indexes[lowering_uid]

        events = self._get(EVENT_EXPORTS_API_PATH + '/bylowering/' + lowering_uid,
                           {'datasource': FRAMEGRAB_DATA_SOURCE}) or []

        stamps = []
        frames = []

        for event in events:
            for aux_data in event.get('aux_data', []):
                if aux_data.get('data_source') != FRAMEGRAB_DATA_SOURCE:
                    continue

                cameras = [kv['data_value'] for kv in aux_data['data_array'] if kv['data_name'] == 'camera_name']
                filenames = [kv['data_value'] for kv in aux_data['data_array'] if kv['data_name'] == 'filename']

                if not filenames:
                    continue

                stamps.append(parse_sealog_ts(event['ts']))
                frames.append(dict(zip(cameras, filenames)))

        order = sorted(range(len(stamps)), key=stamps.__getitem__)
        index = {
            'stamps': [stamps[i] for i in order],
            'frames': [frames[i] for i in order]
        }
        index['first'] = index['stamps'][0] if index['stamps'] else datetime.max.replace(tzinfo=timezone.utc)
        index['last'] = index['stamps'][-1] if index['stamps'] else datetime.min.replace(tzinfo=timezone.utc)

        self._indexes[lowering_uid] = index
        logging.info('indexed %d framegrab events for lowering %s', len(index['stamps']), lowering_uid)

        return index

    def nearest_frame(self, lowering_uid, stamp):
        '''
        Return (event_ts, {camera: filename}) for the framegrab event closest to
        the given timestamp, or None if there are no framegrabs at all.
        '''

        index = self.framegrab_index(lowering_uid)
        stamps = index['stamps']

        if not stamps:
            return None

        pos = bisect.bisect_left(stamps, stamp)
        candidates = [i for i in (pos - 1, pos) if 0 <= i < len(stamps)]
        best = min(candidates, key=lambda i: abs((stamps[i] - stamp).total_seconds()))

        return stamps[best], index['frames'][best]

    def resolve(self, url, camera=None):
        '''
        Resolve a 4dgeo image URL to the matching sealog image(s).  Returns a
        result dict; 'status' is 'matched' on success and describes the reason
        otherwise.
        '''

        parts = parse_4dgeo_url(url)
        stamp = parts['ts'] - timedelta(hours=self.utc_offset)

        result = {
            'source_url': url,
            'cruise': parts['cruise'],
            'source': parts['source'],
            'ts': stamp.isoformat().replace('+00:00', 'Z'),
            'lowering_id': None,
            'camera': camera,
            'sealog_url': None,
            'delta_sec': None,
            'status': None
        }

        try:
            lowering = self.find_lowering(stamp)
        except ResolveError as error:
            result['status'] = str(error)
            return result

        if lowering is None:
            result['status'] = 'no lowering covers this timestamp'
            return result

        result['lowering_id'] = lowering['lowering_id']

        try:
            nearest = self.nearest_frame(lowering['id'], stamp)
        except ResolveError as error:
            result['status'] = str(error)
            return result

        if nearest is None:
            result['status'] = 'lowering has no framegrabs in sealog'
            return result

        event_ts, frames = nearest
        delta = (event_ts - stamp).total_seconds()
        result['delta_sec'] = round(delta, 3)

        if abs(delta) > self.tolerance:
            result['status'] = 'nearest framegrab is %.3fs away (tolerance %.3fs)' % (delta, self.tolerance)
            return result

        if camera is None:
            result['camera'] = ','.join(sorted(frames))
            result['sealog_url'] = ','.join(self.image_url(frames[cam]) for cam in sorted(frames))
        elif camera in frames:
            result['sealog_url'] = self.image_url(frames[camera])
        else:
            result['status'] = 'camera %s not in this event (have: %s)' % (camera, ','.join(sorted(frames)))
            return result

        result['status'] = 'matched'

        return result

    def verify(self, url):
        '''
        HEAD a resolved sealog image URL and return True when it is served.
        '''

        try:
            req = requests.head(url, headers=self.headers, timeout=60)
            return req.status_code == 200
        except Exception as error: # pylint: disable=broad-except
            logging.warning('could not verify %s: %s', url, error)
            return False


def parse_camera_map(value):
    '''
    Parse a --camera-map argument, e.g. "Src1=SciCam,Src2=PilotCam".
    '''

    camera_map = {}

    for pair in filter(None, (item.strip() for item in (value or '').split(','))):
        if '=' not in pair:
            raise ValueError('expected Src<n>=CameraName, got %s' % pair)

        source, camera = pair.split('=', 1)
        camera_map[source.strip()] = camera.strip()

    return camera_map


# -------------------------------------------------------------------------------------
# Required python code for running the script as a stand-alone utility
# -------------------------------------------------------------------------------------
if __name__ == "__main__":

    import argparse
    import os

    parser = argparse.ArgumentParser(description='Map 4dgeo DAQ image URLs to sealog image URLs.')
    parser.add_argument('-v', '--verbosity', dest='verbosity',
                        default=0, action='count',
                        help='Increase output verbosity')
    parser.add_argument('--api-server-url', default=API_SERVER_URL,
                        help='Sealog API server url (default: %(default)s)')
    parser.add_argument('--token', default=None,
                        help='JWT for the sealog API.  Required for embargoed lowerings.')
    parser.add_argument('--camera-map', default='',
                        help='4dgeo source to sealog camera mapping, e.g. "Src1=SciCam,Src2=PilotCam".'
                             '  Unmapped sources emit every camera held for the matched event.')
    parser.add_argument('--tolerance', type=float, default=DEFAULT_TOLERANCE,
                        help='Maximum seconds between the 4dgeo frame and the sealog frame (default: %(default)s)')
    parser.add_argument('--utc-offset', type=float, default=0.0,
                        help='Hours to subtract from 4dgeo filename timestamps to get UTC (default: %(default)s)')
    parser.add_argument('--verify', action='store_true',
                        help='HEAD each resolved url and report whether the image is actually served')
    parser.add_argument('--format', choices=['csv', 'json'], default='csv',
                        help='Output format (default: %(default)s)')
    parser.add_argument('url', nargs='*',
                        help='4dgeo image url(s).  Reads urls from stdin, one per line, when omitted.')

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
        CAMERA_MAP = parse_camera_map(parsed_args.camera_map)
    except ValueError as err:
        parser.error(str(err))

    REQUEST_HEADERS = dict(HEADERS)
    if parsed_args.token:
        REQUEST_HEADERS['authorization'] = parsed_args.token

    RESOLVER = SealogImageResolver(api_server_url=parsed_args.api_server_url,
                                   headers=REQUEST_HEADERS,
                                   tolerance=parsed_args.tolerance,
                                   utc_offset=parsed_args.utc_offset)

    URLS = parsed_args.url or [line.strip() for line in sys.stdin if line.strip()]

    FIELDS = ['source_url', 'cruise', 'source', 'ts', 'lowering_id', 'camera', 'sealog_url', 'delta_sec', 'status']
    if parsed_args.verify:
        FIELDS.append('verified')

    RESULTS = []
    WRITER = None

    if parsed_args.format == 'csv':
        WRITER = csv.DictWriter(sys.stdout, fieldnames=FIELDS)
        WRITER.writeheader()

    EXIT_CODE = 0

    try:
        for image_url in URLS:
            try:
                parsed = parse_4dgeo_url(image_url)
                row = RESOLVER.resolve(image_url, camera=CAMERA_MAP.get(parsed['source']))
            except ResolveError as err:
                row = dict.fromkeys(FIELDS)
                row['source_url'] = image_url
                row['status'] = str(err)

            if parsed_args.verify:
                row['verified'] = RESOLVER.verify(row['sealog_url']) if row.get('sealog_url') else False

            if row['status'] != 'matched':
                EXIT_CODE = 1
                logging.warning('%s: %s', image_url, row['status'])

            if WRITER:
                WRITER.writerow(row)
            else:
                RESULTS.append(row)

        if parsed_args.format == 'json':
            json.dump(RESULTS, sys.stdout, indent=2)
            sys.stdout.write('\n')

        sys.exit(EXIT_CODE)

    except KeyboardInterrupt:
        logging.warning('Interrupted')
        try:
            sys.exit(0)
        except SystemExit:
            os._exit(0) # pylint: disable=protected-access
