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

// Stable, human-readable links into Sealog, keyed by names that outside
// systems already know (the dive's lowering_id, a camera name, a time)
// instead of database ids or millisecond-precision filenames.
//
//   /links/lowerings/{lowering_id}                      -> the dive in the client
//   /links/images/{lowering_id}/{camera}/{timestamp}    -> the nearest framegrab
//
// See docs/stable-links.md.

const FRAMEGRAB_DATA_SOURCE = 'vehicleRealtimeFramegrabberData';
const LOWERING_VIEWS = ['gallery', 'map', 'replay'];

const DEFAULT_TOLERANCE_SECONDS = 30;
const MAX_TOLERANCE_SECONDS = 600;

// Accepts 20250210_183242, 20250210_183242956 or any ISO 8601 date-time.
const parseTimestamp = (value) => {

  const compact = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?$/.exec(value);
  if (compact) {
    const [, year, month, day, hour, minute, second, millis] = compact;
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis || '000'}Z`);
    return isNaN(date) ? null : date;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    return isNaN(date) ? null : date;
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
const imagePath = (filename, depth) => {

  const encoded = filename.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return '../'.repeat(depth) + 'files/images/' + encoded;
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
    const cruise = await findParentCruise(db, cruisesTable, lowering);
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
      path: '/links/lowerings/{lowering_id}',
      async handler(request, h) {

        const lowering = await findAccessibleLowering(request);

        const view = request.query.view || 'gallery';
        const clientPath = `lowering_${view}/${lowering._id}`;
        const clientURL = process.env.SEALOG_CLIENT_URL;

        if (request.query.format === 'json' || !clientURL) {
          return h.response({
            id: lowering._id.toString(),
            lowering_id: lowering.lowering_id,
            start_ts: lowering.start_ts,
            stop_ts: lowering.stop_ts,
            client_path: clientPath
          }).code(200);
        }

        return h.redirect(clientURL.replace(/\/*$/, '/') + clientPath).code(302);
      },
      config: {
        auth: {
          strategy: 'jwt',
          mode: 'try'
        },
        validate: {
          params: Joi.object({
            lowering_id: loweringIdParam
          }).label('linkLoweringParam'),
          query: Joi.object({
            view: Joi.string().valid(...LOWERING_VIEWS).optional(),
            format: Joi.string().valid('json').optional()
          }).optional().label('linkLoweringQuery')
        },
        description: 'Stable link to a lowering, by its lowering_id',
        notes: '<p>Redirects to the lowering in the Sealog client (gallery by default; ?view=map or ?view=replay). \
          The client\'s base URL comes from the SEALOG_CLIENT_URL environment variable; when it is not set, or with \
          ?format=json, the lowering\'s id and client path are returned as JSON instead.</p>\
          <p>No authorization required for public lowerings.</p>',
        tags: ['lowerings', 'api', 'links']
      }
    });

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

            events.sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target));

            for (const event of events) {
              const framegrab = (auxByEvent.get(event._id.toString()) || [])
                .find((grab) => grab.filename && cameraAliases(grab.camera_name, grab.filename).has(camera));

              if (framegrab) {
                match = { event, framegrab };
                break;
              }
            }
          }
          catch (err) {
            console.log('ERROR:', err);
            return Boom.serverUnavailable('database error');
          }
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
            image_path: location
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
          With ?format=json the match is returned as JSON, including how far it is from the requested time.</p>\
          <p>No authorization required for public lowerings.</p>',
        tags: ['events', 'api', 'links', 'image_files']
      }
    });
  }
};

exports.internals = { parseTimestamp, cameraAliases, framegrabsFromAuxData, imagePath };
