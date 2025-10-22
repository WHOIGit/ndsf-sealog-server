const Boom = require('@hapi/boom');
const Joi = require('joi');
const { flattenEventJSON, convertToCSV } = require('./json_util');

const {
  useAccessControl
} = require('../../../config/email_constants');

const {
  eventsTable,
  eventAuxDataTable,
  loweringsTable,
  cruisesTable
} = require('../../../config/db_constants');


const _renameAndClearFields = (doc) => {

  //rename id
  doc.id = doc._id;
  delete doc._id;
  delete doc.event_id;

  if (doc.aux_data && doc.aux_data.length > 0) {
    doc.aux_data.forEach(_renameAndClearFields);
  }

  return doc;
};

const _buildEventsQuery = (request, start_ts = new Date("1970-01-01T00:00:00.000Z"), stop_ts = new Date() ) => {

  const query = {};
  if (request.query.author) {
    if (Array.isArray(request.query.author)) {
      const regex_query = request.query.author.map((author) => {

        const return_regex = new RegExp(author, 'i');
        return return_regex;
      });

      query.event_author  = { $in: regex_query };
    }
    else {
      query.event_author =  new RegExp(request.query.author, 'i');
    }
  }

  if (request.query.value) {
    if (Array.isArray(request.query.value)) {

      const inList = [];
      const ninList = [];

      for ( const value of request.query.value ) {
        if (value.startsWith("!")) {
          ninList.push( new RegExp(value.substr(1), 'i'));
        }
        else {
          inList.push(new RegExp(value, 'i'));
        }
      }

      if ( inList.length > 0 && ninList.length > 0) {
        query.event_value  = { $in: inList, $nin: ninList };
      }
      else if (inList.length > 0) {
        query.event_value  = { $in: inList };
      }
      else {
        query.event_value  = { $nin: ninList };
      }

    }
    else {
      if (request.query.value.startsWith("!")) {
        query.event_value = new RegExp('^(?!.*' + request.query.value.substr(1) + ')', 'i');
      }
      else {
        query.event_value = new RegExp(request.query.value, 'i');
      }
    }
  }

  if (request.query.freetext) {
    query.event_free_text = new RegExp(request.query.freetext, 'i');
  }

  //Time filtering
  if (request.query.startTS) {
    const tempStartTS = new Date(request.query.startTS);
    const startTS = (tempStartTS >= start_ts && tempStartTS <= stop_ts) ? tempStartTS : start_ts;
    query.ts = { $gte: startTS };
  }
  else {
    query.ts = { $gte: start_ts };
  }

  if (request.query.stopTS) {
    const tempStopTS = new Date(request.query.stopTS);
    const stopTS = (tempStopTS >= start_ts && tempStopTS <= stop_ts) ? tempStopTS : stop_ts;
    query.ts.$lte = stopTS;
  }
  else {
    query.ts.$lte = stop_ts;
  }

  // console.log("query:", query);
  return query;
};

const authorizationHeader = Joi.object({
  authorization: Joi.string().required()
}).options({ allowUnknown: true }).label('authorizationHeader');

const eventParam = Joi.object({
  id: Joi.string().length(24).required()
}).label('eventParam');

const eventExportSuccessResponse = Joi.object({
  id: Joi.object(),
  event_author: Joi.string(),
  ts: Joi.date().iso(),
  event_value: Joi.string(),
  event_options: Joi.array().items(Joi.object({
    event_option_name: Joi.string(),
    event_option_value: Joi.string().allow('')
  })),
  event_free_text: Joi.string().allow(''),
  aux_data: Joi.array().items(Joi.object({
    id: Joi.object(),
    data_source: Joi.string(),
    data_array: Joi.array().items(Joi.object({
      data_name: Joi.string(),
      data_value: Joi.alternatives().try(
        Joi.string(),
        Joi.number()
      ),
      data_uom: Joi.string()
    }))
  }))
}).label('eventExportSuccessResponse');

const eventExportQuery = Joi.object({
  format: Joi.string().optional(),
  offset: Joi.number().integer().min(0).optional(),
  limit: Joi.number().integer().min(1).optional(),
  author: Joi.alternatives().try(
    Joi.string(),
    Joi.array().items(Joi.string()).optional()
  ).optional(),
  startTS: Joi.date().optional(),
  stopTS: Joi.date().optional(),
  datasource: Joi.alternatives().try(
    Joi.string(),
    Joi.array().items(Joi.string()).optional()
  ).optional(),
  value: Joi.alternatives().try(
    Joi.string(),
    Joi.array().items(Joi.string()).optional()
  ).optional(),
  freetext: Joi.string().optional(),
  use_renav: Joi.boolean().optional()
}).optional().label('eventExportQuery');

exports.plugin = {
  name: 'routes-api-event-exports',
  dependencies: ['hapi-mongodb', '@hapi/nes'],
  register: (server, options) => {

    server.route({
      method: 'GET',
      path: '/event_exports/bycruise/{id}',
      async handler(request, h) {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        let cruise = null;

        try {
          cruise = await db.collection(cruisesTable).findOne({ _id: new ObjectID(request.params.id) });
        }
        catch (err) {
          console.log("ERROR:", err);
          return Boom.serverUnavailable('database error');
        }

        if (!cruise) {
          return Boom.notFound('cruise not found for that id');
        }

        // Check if user can access this cruise
        if (cruise.cruise_hidden) {
          // If not authenticated, cannot access hidden cruises
          if (!request.auth.credentials || !request.auth.credentials.scope) {
            return Boom.unauthorized('Cannot access hidden cruise without authentication');
          }
          // If authenticated but not admin, check access list
          if (!request.auth.credentials.scope.includes("admin") &&
              (useAccessControl && !((cruise.cruise_access_list || []).includes(request.auth.credentials.id)))) {
            return Boom.unauthorized('User not authorized to retrieve this cruise');
          }
        }

        const query = _buildEventsQuery(request, cruise.start_ts, cruise.stop_ts);
        const offset = (request.query.offset) ? request.query.offset : 0;

        const lookup = {
          from: eventAuxDataTable,
          localField: "_id",
          foreignField: "event_id",
          as: "aux_data"
        };

        const aggregate = [];
        aggregate.push({ $match: query });
        aggregate.push({ $lookup: lookup });
        aggregate.push({ $sort: { ts: 1 } });

        if (request.query.limit) {
          aggregate.push({ $limit: request.query.limit });
        }

        // console.log("aggregate:", aggregate);
        let results = [];

        try {
          results = await db.collection(eventsTable).aggregate(aggregate, { allowDiskUse: true }).skip(offset).toArray();
        }
        catch (err) {
          console.log(err);
          return Boom.serverUnavailable('database error');
        }

        if (results.length > 0) {

          // datasource filtering
          if (request.query.datasource) {

            const datasource_query = {};

            const eventIDs = results.map((event) => event._id);

            datasource_query.event_id = { $in: eventIDs };

            if (Array.isArray(request.query.datasource)) {
              datasource_query.data_source  = { $in: request.query.datasource };
            }
            else {
              datasource_query.data_source  = request.query.datasource;
            }

            let aux_data_results = [];
            try {
              aux_data_results = await db.collection(eventAuxDataTable).find(datasource_query, { _id: 0, event_id: 1 }).toArray();
            }
            catch (err) {
              console.log(err);
              return Boom.serverUnavailable('database error');
            }

            const aux_data_eventID_set = new Set(aux_data_results.map((aux_data) => String(aux_data.event_id)));

            results = results.filter((event) => {

              return (aux_data_eventID_set.has(String(event._id))) ? event : null;
            });

          }

          results.forEach(_renameAndClearFields);

          if (request.query.format && request.query.format === "csv") {
            const { events } = flattenEventJSON(results);
            csv_results = convertToCSV(events, request.query.use_renav);

            return h.response(csv_results)
              .type('text/html').code(200);
          }

          return h.response(results).code(200);
        }

        return Boom.notFound('No records found');
      },
      config: {
        auth: {
          strategy: 'jwt',
          mode: 'try'
        },
        validate: {
          params: eventParam,
          query: eventExportQuery
        },
        description: 'Export the events merged with their event_aux_data records for a cruise based on the cruise id',
        notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
          <p>Available to: <strong>admin</strong>, <strong>event_manager</strong>, <strong>event_logger</strong> or <strong>event_watcher</strong></p>',
        tags: ['event_exports','api']
      }
    });

    server.route({
      method: 'GET',
      path: '/event_exports/bylowering/{id}',
      async handler(request, h) {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        let lowering = null;

        try {
          lowering = await db.collection(loweringsTable).findOne({ _id: new ObjectID(request.params.id) });
        }
        catch (err) {
          console.log("ERROR:", err);
          return Boom.serverUnavailable('database error');
        }

        if (!lowering) {
          return Boom.notFound('lowering not found for that id');
        }

        // Check if user can access this lowering
        if (lowering.lowering_hidden) {
          // If not authenticated, cannot access hidden lowerings
          if (!request.auth.credentials || !request.auth.credentials.scope) {
            return Boom.unauthorized('Cannot access hidden lowering without authentication');
          }
          // If authenticated but not admin, check access list
          if (!request.auth.credentials.scope.includes("admin") &&
              (useAccessControl && !((lowering.lowering_access_list || []).includes(request.auth.credentials.id)))) {
            return Boom.unauthorized('User not authorized to retrieve this lowering');
          }
        }

        const query = _buildEventsQuery(request, lowering.start_ts, lowering.stop_ts);
        const offset = (request.query.offset) ? request.query.offset : 0;

        const lookup = {
          from: eventAuxDataTable,
          localField: "_id",
          foreignField: "event_id",
          as: "aux_data"
        };

        const aggregate = [];
        aggregate.push({ $match: query });
        aggregate.push({ $lookup: lookup });
        aggregate.push({ $sort: { ts: 1 } });

        if (request.query.limit) {
          aggregate.push({ $limit: request.query.limit });
        }

        // console.log("aggregate:", aggregate);
        let results = [];

        try {
          results = await db.collection(eventsTable).aggregate(aggregate, { allowDiskUse: true }).skip(offset).toArray();
        }
        catch (err) {
          console.log(err);
          return Boom.serverUnavailable('database error');
        }

        if (results.length > 0) {

          // datasource filtering
          if (request.query.datasource) {

            const datasource_query = {};

            const eventIDs = results.map((event) => event._id);

            datasource_query.event_id = { $in: eventIDs };

            if (Array.isArray(request.query.datasource)) {
              datasource_query.data_source  = { $in: request.query.datasource };
            }
            else {
              datasource_query.data_source  = request.query.datasource;
            }

            let aux_data_results = [];
            try {
              aux_data_results = await db.collection(eventAuxDataTable).find(datasource_query, { _id: 0, event_id: 1 }).toArray();
            }
            catch (err) {
              console.log(err);
              return Boom.serverUnavailable('database error');
            }

            const aux_data_eventID_set = new Set(aux_data_results.map((aux_data) => String(aux_data.event_id)));

            results = results.filter((event) => {
              
              return (aux_data_eventID_set.has(String(event._id))) ? event : null;
            });
          }

          results.forEach(_renameAndClearFields);

          if (request.query.format && request.query.format === "csv") {
            const { events } = flattenEventJSON(results);
            csv_results = convertToCSV(events, request.query.use_renav);

            return h.response(csv_results)
              .type('text/html').code(200);
          }

          return h.response(results).code(200);
        }

        return Boom.notFound('No records found');
      },
      config: {
        auth: {
          strategy: 'jwt',
          mode: 'try'
        },
        validate: {
          params: eventParam,
          query: eventExportQuery
        },
        description: 'Export the events merged with their event_aux_data records for a lowering based on the lowering id',
        notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
          <p>Available to: <strong>admin</strong>, <strong>event_manager</strong>, <strong>event_logger</strong> or <strong>event_watcher</strong></p>',
        tags: ['event_exports','api']
      }
    });

    // REMOVED: GET /event_exports and GET /event_exports/{id} routes
    // These routes allowed exporting events by arbitrary timestamp ranges without
    // checking if the parent cruise/lowering was hidden, creating a data leak.
    // Users should use /event_exports/bycruise/{id} or /event_exports/bylowering/{id}
    // which properly enforce hidden data access controls.
  }
};
