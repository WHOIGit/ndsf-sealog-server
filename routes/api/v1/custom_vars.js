const Boom = require('@hapi/boom');
const Joi = require('joi');

const {
  customVarsTable
} = require('../../../config/db_constants');

const _renameAndClearFields = (doc) => {

  //rename id
  doc.id = doc._id;
  delete doc._id;

  return doc;
};

const authorizationHeader = Joi.object({
  authorization: Joi.string().required()
}).options({ allowUnknown: true }).label('authorizationHeader');

// const databaseInsertResponse = Joi.object({
//   n: Joi.number().integer(),
//   ok: Joi.number().integer(),
//   insertedCount: Joi.number().integer(),
//   insertedId: Joi.object()
// }).label('databaseInsertResponse');

const customVarParam = Joi.object({
  id: Joi.string().length(24).required()
}).label('customVarParam');

const customVarResponse = Joi.object({
  id: Joi.object(),
  custom_var_name: Joi.string(),
  custom_var_value: Joi.string().allow('')
}).label('customVarResponse');

const customVarUpdatePayload = Joi.object({
  custom_var_name: Joi.string().optional(),
  custom_var_value: Joi.string().allow('').optional()
}).required().min(1).label('customVarUpdatePayload');

exports.plugin = {
  name: 'routes-api-custom_vars',
  dependencies: ['hapi-mongodb', '@hapi/nes'],
  register: (server, options) => {

    server.subscription('/ws/status/updateCustomVars');

    server.route({
      method: 'GET',
      path: '/custom_vars',
      async handler(request, h) {

        const db = request.mongo.db;
        // const ObjectID = request.mongo.ObjectID;

        const query = {};

        if (request.query.name) {
          if (Array.isArray(request.query.name)) {
            query.custom_var_name  = { $in: request.query.name };
          }
          else {
            query.custom_var_name  = request.query.name;
          }
        }

        // console.log("query:", query)

        try {
          const results = await db.collection(customVarsTable).find(query).toArray();

          // console.log("results:", results);
          if (results.length > 0) {

            results.forEach(_renameAndClearFields);

            return h.response(results).code(200);
          }
 
          return Boom.notFound('No records found');
          
        }
        catch (err) {
          return Boom.serverUnavailable('database error', err);
        }
      },
      config: {
        auth: {
          strategy: 'jwt',
          scope: ['admin', 'read_events']
        },
        validate: {
          headers: authorizationHeader,
          query: Joi.object({
            name: Joi.string()
          }).optional()
        },
        response: {
          status: {
            200: Joi.array().items(customVarResponse)
          }
        },
        description: 'Return the custom vars based on query parameters',
        notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
          <p>Available to: <strong>admin</strong>, <strong>event_manager</strong>, <strong>event_logger</strong> or <strong>event_watcher</strong></p>',
        tags: ['custom_vars', 'api']
      }
    });

    server.route({
      method: 'GET',
      path: '/custom_vars/{id}',
      async handler(request, h) {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const query = {};

        try {
          query._id = new ObjectID(request.params.id);
        }
        catch (err) {
          return Boom.badRequest('id must be a single String of 12 bytes or a string of 24 hex characters');
        }

        try {
          const result = await db.collection(customVarsTable).findOne(query);
          if (!result) {
            return Boom.notFound('No record found for id: ' + request.params.id);
          }

          const mod_result = _renameAndClearFields(result);
          return h.response(mod_result).code(200);
        }
        catch (err) {
          return Boom.serverUnavailable('database error', err);
        }
      },
      config: {
        auth: {
          strategy: 'jwt',
          scope: ['admin', 'read_events']
        },
        validate: {
          headers: authorizationHeader,
          params: customVarParam
        },
        response: {
          status: {
            200: customVarResponse
          }
        },
        description: 'Return the custom_var based on custom_var id',
        notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
          <p>Available to: <strong>admin</strong>, <strong>event_manager</strong>, <strong>event_logger</strong> or <strong>event_watcher</strong></p>',
        tags: ['custom_vars','api']
      }
    });

    server.route({
      method: 'PATCH',
      path: '/custom_vars/{id}',
      async handler(request, h) {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const query = {};
        let custom_var_name = '';

        try {
          query._id = new ObjectID(request.params.id);
        }
        catch (err) {
          return Boom.badRequest('id must be a single String of 12 bytes or a string of 24 hex characters');
        }

        try {
          const result = await db.collection(customVarsTable).findOne(query);

          if (!result) {
            return Boom.notFound('No record found for id: ' + request.params.id);
          }

          custom_var_name = result.custom_var_name;
        }
        catch (err) {
          return Boom.serverUnavailable('database error', err);
        }

        try {
          await db.collection(customVarsTable).updateOne(query, { $set: request.payload });

          const custom_var = { id: request.params.id, custom_var_name, custom_var_value: request.payload.custom_var_value };

          server.publish('/ws/status/updateCustomVars', custom_var );

          return h.response().code(204);

        }
        catch (err) {
          return Boom.serverUnavailable('database error', err);
        }   
      },
      config: {
        auth: {
          strategy: 'jwt',
          scope: ['admin', 'write_events']
        },
        validate: {
          headers: authorizationHeader,
          params: customVarParam,
          payload: customVarUpdatePayload
        },
        response: {
          status: {}
        },
        description: 'Update a custom var record',
        notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
          <p>Available to: <strong>admin</strong>, <strong>event_manager</strong> or <strong>event_logger</strong></p>',
        tags: ['custom_vars','api']
      }
    });
  }
};
