const Boom = require('@hapi/boom');
const Joi = require('joi');

const {
  checkEntityAccess,
  findParentCruise
} = require('../lib/access_control');

const {
  cruisesTable,
  eventAuxDataTable,
  eventsTable,
  loweringsTable
} = require('../config/db_constants');

// A stable, human-readable link to a framegrab, keyed by names that outside
// systems already know (the dive's lowering_id, a camera name, a time)
// instead of the millisecond-precision filename:
//
//   /links/images/{lowering_id}/{camera}/{timestamp}    -> the nearest framegrab
//
// (Lowerings already have stable links: the client opens
// /lowering_gallery/{lowering_id} by name.)

const FRAMEGRAB_DATA_SOURCE = 'vehicleRealtimeFramegrabberData';

const DEFAULT_TOLERANCE_SECONDS = 30;
const MAX_TOLERANCE_SECONDS = 600;

// Build a UTC date from its fields, refusing ones that don't exist
// (February 30th, hour 24) rather than letting them roll over.
const utcDate = (year, month, day, hour, minute, second, millis) => {

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));

  if (isNaN(date) ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
    date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    return null;
  }

  return date;
};

// Accepts 20250210_183242, 20250210_183242956 or an ISO 8601 date-time.
// Times are UTC unless the ISO form gives an offset.
const parseTimestamp = (value) => {

  const compact = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?$/.exec(value);
  if (compact) {
    const [year, month, day, hour, minute, second] = compact.slice(1, 7).map(Number);
    return utcDate(year, month, day, hour, minute, second, Number(compact[7] || 0));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (iso) {
    const [year, month, day, hour, minute] = iso.slice(1, 6).map(Number);
    const second = Number(iso[6] || 0);
    const millis = Number((iso[7] || '0').padEnd(3, '0'));
    const date = utcDate(year, month, day, hour, minute, second, millis);
    if (!date) {
      return null;
    }

    const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(iso[8] || '');
    if (offset) {
      const offsetMinutes = Number(offset[2]) * 60 + Number(offset[3]);
      if (Number(offset[2]) > 23 || Number(offset[3]) > 59) {
        return null;
      }

      return new Date(date.getTime() - (offset[1] === '-' ? -1 : 1) * offsetMinutes * 60000);
    }

    return date;
  }

  return null;
};

// The names a framegrab can be asked for by. Over the years the same camera
// has been labelled "SciCam", "SubSea1" or "port_brow_4k (Framegrabber 1)"
// with a directory of "port_brow_4k.framegrab01", so accept any of them.
const cameraAliases = (cameraName, filename) => {

  const aliases = new Set();
  const add = (name) => {

    if (name) {
      aliases.add(name.trim().toLowerCase());
    }
  };

  if (cameraName) {
    add(cameraName);
    add(cameraName.replace(/\s*\(.*\)\s*$/, ''));
  }

  if (filename) {
    const parts = filename.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const dir = parts[parts.length - 2];
      add(dir);
      add(dir.split('.')[0]);
    }
  }

  return aliases;
};

// A framegrab aux data record holds camera_name/filename pairs in order.
const framegrabsFromAuxData = (auxData) => {

  const framegrabs = [];
  let cameraName = null;

  (auxData.data_array || []).forEach((datum) => {

    if (datum.data_name === 'camera_name') {
      cameraName = datum.data_value;
    }
    else if (datum.data_name === 'filename') {
      framegrabs.push({ camera_name: cameraName, filename: datum.data_value });
      cameraName = null;
    }
  });

  return framegrabs;
};

// Build a URL path for an image under /files/images, relative to the route
// that was requested, so the redirect works behind any reverse-proxy prefix.
const encodeFilename = (filename) => filename.split('/').filter(Boolean).map(encodeURIComponent).join('/');

const imagePath = (filename, depth) => '../'.repeat(depth) + 'files/images/' + encodeFilename(filename);

// Nearest first; ties go to the earlier event, then the lower _id, so the
// same link always resolves to the same frame.
const byNearness = (target) => (a, b) => {

  return (Math.abs(a.ts - target) - Math.abs(b.ts - target)) ||
    (a.ts - b.ts) ||
    a._id.toString().localeCompare(b._id.toString());
};

// The framegrab directory, e.g. "port_brow_4k.framegrab01".
const imageDirectory = (filename) => {

  const parts = filename.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : filename;
};

const findAccessibleLowering = async (request) => {

  const db = request.mongo.db;

  let lowering;
  try {
    lowering = await db.collection(loweringsTable).findOne({ lowering_id: request.params.lowering_id });
  }
  catch (err) {
    console.log('ERROR:', err);
    throw Boom.serverUnavailable('database error');
  }

  if (!lowering) {
    throw Boom.notFound('No record found for lowering_id: ' + request.params.lowering_id);
  }

  if (!checkEntityAccess(lowering, 'lowering', request)) {
    throw Boom.unauthorized('User not authorized to retrieve this lowering');
  }

  if (lowering.stop_ts) {
    let cruise;
    try {
      cruise = await findParentCruise(db, cruisesTable, lowering);
    }
    catch (err) {
      console.log('ERROR:', err);
      throw Boom.serverUnavailable('database error');
    }

    if (cruise && !checkEntityAccess(cruise, 'cruise', request)) {
      throw Boom.unauthorized('User not authorized to retrieve this lowering');
    }
  }

  return lowering;
};

const loweringIdParam = Joi.string().pattern(/^[^/]+$/).required();

exports.plugin = {
  name: 'routes-links',
  dependencies: ['hapi-mongodb'],
  register: (server, options) => {

    server.route({
      method: 'GET',
      path: '/links/images/{lowering_id}/{camera}/{timestamp}',
      async handler(request, h) {

        const db = request.mongo.db;
        const lowering = await findAccessibleLowering(request);

        const target = parseTimestamp(request.params.timestamp);
        if (!target) {
          return Boom.badRequest('timestamp must be YYYYMMDD_HHMMSS, YYYYMMDD_HHMMSSmmm or ISO 8601');
        }

        const toleranceMs = (request.query.tolerance ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
        const lo = Math.max(target.getTime() - toleranceMs, lowering.start_ts.getTime());
        const hi = lowering.stop_ts ? Math.min(target.getTime() + toleranceMs, lowering.stop_ts.getTime()) : target.getTime() + toleranceMs;
        const camera = request.params.camera.toLowerCase();

        let match = null;
        let ambiguous = null;

        if (lo <= hi) {
          try {
            const events = await db.collection(eventsTable)
              .find({ ts: { $gte: new Date(lo), $lte: new Date(hi) } }, { projection: { _id: 1, ts: 1 } })
              .toArray();

            const auxData = events.length === 0 ? [] : await db.collection(eventAuxDataTable)
              .find({ event_id: { $in: events.map((event) => event._id) }, data_source: FRAMEGRAB_DATA_SOURCE })
              .toArray();

            const auxByEvent = new Map();
            auxData.forEach((record) => {

              const key = record.event_id.toString();
              auxByEvent.set(key, (auxByEvent.get(key) || []).concat(framegrabsFromAuxData(record)));
            });

            events.sort(byNearness(target));

            for (const event of events) {
              const framegrabs = (auxByEvent.get(event._id.toString()) || [])
                .filter((grab) => grab.filename && cameraAliases(grab.camera_name, grab.filename).has(camera));

              if (framegrabs.length === 0) {
                continue;
              }

              // A short name like "port_brow_4k" can cover several framegrabbers.
              const directories = [...new Set(framegrabs.map((grab) => imageDirectory(grab.filename)))];
              if (directories.length > 1) {
                ambiguous = directories;
              }
              else {
                match = { event, framegrab: framegrabs[0] };
              }

              break;
            }
          }
          catch (err) {
            console.log('ERROR:', err);
            return Boom.serverUnavailable('database error');
          }
        }

        if (ambiguous) {
          return Boom.conflict(`${request.params.camera} matches more than one camera in ${lowering.lowering_id}: ${ambiguous.join(', ')}. Use one of those names instead.`);
        }

        if (!match) {
          return Boom.notFound(`No ${request.params.camera} framegrab within ${toleranceMs / 1000} s of ${target.toISOString()} in ${lowering.lowering_id}`);
        }

        // Path is /links/images/{lowering_id}/{camera}/{timestamp}: four levels below the server root.
        const location = imagePath(match.framegrab.filename, 4);

        if (request.query.format === 'json') {
          return h.response({
            lowering_id: lowering.lowering_id,
            event_id: match.event._id.toString(),
            ts: match.event.ts,
            delta_seconds: (match.event.ts - target) / 1000,
            camera_name: match.framegrab.camera_name,
            filename: match.framegrab.filename,
            image_path: location,
            server_path: request.path.replace(/\/links\/images\/.*$/, '') + '/files/images/' + encodeFilename(match.framegrab.filename)
          }).code(200);
        }

        return h.redirect(location).code(302);
      },
      config: {
        auth: {
          strategy: 'jwt',
          mode: 'try'
        },
        validate: {
          params: Joi.object({
            lowering_id: loweringIdParam,
            camera: Joi.string().pattern(/^[^/]+$/).required(),
            timestamp: Joi.string().required()
          }).label('linkImageParam'),
          query: Joi.object({
            tolerance: Joi.number().min(0).max(MAX_TOLERANCE_SECONDS).optional(),
            format: Joi.string().valid('json').optional()
          }).optional().label('linkImageQuery')
        },
        description: 'Stable link to a framegrab, by lowering_id, camera and time',
        notes: '<p>Redirects to the framegrab from the given camera nearest to the given time within the lowering, \
          searching ?tolerance= seconds either side (default 30, max 600). The camera may be given as the camera \
          name ("port_brow_4k"), its image directory ("port_brow_4k.framegrab01") or its full camera_name. \
          If a short camera name covers more than one camera (port_brow_4k on framegrabbers 1 and 2), the response \
          is 409 and lists the directory names to use instead.</p>\
          <p>Times are UTC: YYYYMMDD_HHMMSS, YYYYMMDD_HHMMSSmmm, or ISO 8601 (an ISO time with no offset is read as UTC).</p>\
          <p>With ?format=json the match is returned as JSON, including how far it is from the requested time. \
          image_path is relative to the request URL (the same as the redirect); server_path is the image path from \
          this server\'s root.</p>\
          <p>The lowering\'s access rules decide whether a link resolves. The image files themselves are served \
          without authorization.</p>',
        tags: ['api', 'links', 'image_files']
      }
    });
  }
};

exports.internals = { parseTimestamp, cameraAliases, framegrabsFromAuxData, imagePath, byNearness };
