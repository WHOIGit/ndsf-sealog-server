'use strict';

const Bcrypt = require('bcryptjs');
const Joi = require('joi');

const saltRounds = 10;

const {
  usersTable,
} = require('../../../config/db_constants');

const SECRET_KEY = require('../../../config/secret');
const Jwt = require('jsonwebtoken');

exports.register = function (server, options, next) {

  const db = server.mongo.db;
  const ObjectID = server.mongo.ObjectID;

  const _renameAndClearFields = (doc) => {

    //rename id
    doc.id = doc._id;
    delete doc._id;

    //remove fields entirely
    delete doc.password;

    return doc;
  };

  server.route({
    method: 'GET',
    path: '/users',
    handler: function (request, reply) {

      let query = {};

      if(!request.auth.credentials.scope.includes('admin'))
        query.system_user = false;

      let limit = (request.query.limit)? request.query.limit : 0;
      let offset = (request.query.offset)? request.query.offset : 0;
      let sort = (request.query.sort)? { [request.query.sort]: -1 } : { username: -1 };

      db.collection(usersTable).find(query).skip(offset).limit(limit).sort(sort).toArray().then((results) => {
        results.forEach(_renameAndClearFields);
        return reply(results);
      }).catch((err) => {
        console.log("ERROR:", err);
        return reply().code(503);
      });
    },
    config: {
      auth: {
        strategy: 'jwt',
        scope: ['admin', 'event_manager']
      },
      validate: {
        headers: {
          authorization: Joi.string().required()
        },
        query: Joi.object({
          offset: Joi.number().integer().min(0).optional(),
          limit: Joi.number().integer().min(1).optional(),
          sort: Joi.string().valid('username', 'last_login').default('username').optional()
        }),
        options: {
          allowUnknown: true
        }
      },
      response: {
        status: {
          200: Joi.array().items(Joi.object({
            id: Joi.object(),
            email: Joi.string().email(),
            system_user: Joi.boolean(),
            last_login: Joi.date(),
            fullname: Joi.string(),
            username: Joi.string(),
            roles: Joi.array().items(Joi.string()),
          })),
          400: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
          401: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          })
        }
      },
      description: 'Return the current list of users',
      notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
        <p>Available to: <strong>admin</strong></p>',
      tags: ['users','auth','api'],
    }
  });

  server.route({
    method: 'GET',
    path: '/users/{id}',
    handler: function (request, reply) {

      //TODO - add code so that only admins and the user can do this.

      let query = { _id: new ObjectID(request.params.id) };

      db.collection(usersTable).findOne(query).then((result) => {
        
        if(!result) {
          return reply({ "statusCode": 404, 'message': 'No record found for id: ' + request.params.id }).code(404);
        }

        //if the request is for a system user but the requestor is not and admin AND if the requested user is not the requested user 
        if(result.system_user && !request.auth.credentials.scope.includes('admin') && result._id != request.params.id ) {
          return reply({statusCode: 400, error: "Unauthorized", message: "The requesting user is unauthorized to make that request"}).code(400);
        }

        result = _renameAndClearFields(result);
        return reply(result);

      }).catch((err) => {
        console.log("ERROR:", err);
        return reply().code(503);
      });
    },
    config: {
      auth:{
        strategy: 'jwt',
        // scope: 'admin'
      },
      validate: {
        headers: {
          authorization: Joi.string().required()
        },
        params: Joi.object({
          id: Joi.string().length(24).required()
        }),
        options: {
          allowUnknown: true
        }
      },
      response: {
        status: {
          200: Joi.object({
            id: Joi.object(),
            email: Joi.string().email(),
            system_user: Joi.boolean(),
            last_login: Joi.date(),
            fullname: Joi.string(),
            username: Joi.string(),
            roles: Joi.array().items(Joi.string()),
          }),
          400: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
          401: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
          404: Joi.object({
            statusCode: Joi.number().integer(),
            message: Joi.string()
          })
        }
      },
      description: 'Return a single user based on user\'s id',
      notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
        <p>Available to: <strong>admin</strong></p>',
      tags: ['user','auth','api'],
    }
  });

  server.route({
    method: 'POST',
    path: '/users',
    handler: function (request, reply) {

      let query = { username: request.payload.username };

      db.collection(usersTable).findOne(query, (err, result) => {

        if (result) {
          return reply({ "statusCode": 422, 'message': 'Username already exists' }).code(422);
        }

        let user = request.payload;

        if(request.payload.id) {
          try {
            user._id = new ObjectID(request.payload.id);
            delete user.id;
          } catch(err) {
            console.log("invalid ObjectID");
            return reply({statusCode: 400, error: "Invalid argument", message: "id must be a single String of 12 bytes or a string of 24 hex characters"}).code(400);
          }
        }

        // console.log("request.payload:", request.payload);

        user.last_login = new Date("1970-01-01T00:00:00.000Z");

        // If the requesting users is not an admin OR the system_user param is undefined...
        if(!(request.auth.credentials.scope.includes('admin')) || !(request.payload.system_user)) {
          user.system_user = false;
        }

        let password = request.payload.password;

        Bcrypt.genSalt(saltRounds, (err, salt) => {
          Bcrypt.hash(password, salt, (err, hash) => {
        
            user.password = hash;

            db.collection(usersTable).insertOne(user, (err, result) => {

              if (err) {
                console.log("ERROR:", err);
                return reply().code(503);
              }

              if (!result) {
                return reply({ "statusCode": 400, 'message': 'Bad request'}).code(400);
              }

              return reply({ n: result.result.n, ok: result.result.ok, insertedCount: result.insertedCount, insertedId: result.insertedId }).code(201);
            });
          });
        });
      });
    },
    config: {
      auth: {
        strategy: 'jwt',
        scope: ['admin', 'event_manager']
      },
      validate: {
        headers: {
          authorization: Joi.string().required()
        },
        payload: {
          id: Joi.string().length(24).optional(),
          username: Joi.string().min(1).max(100).required(),
          fullname: Joi.string().min(1).max(100).required(),
          system_user: Joi.boolean().optional(),
          email: Joi.string().email().required(),
          password: Joi.string().allow('').max(50).required(),
          roles: Joi.array().items(Joi.string()).min(1).required()
        },
        options: {
          allowUnknown: true
        }
      },
      response: {
        status: {
          201: Joi.object({
            n: Joi.number().integer(),
            ok: Joi.number().integer(),
            insertedCount: Joi.number().integer(),
            insertedId: Joi.object()
          }),
          401: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
          422: Joi.object({
            statusCode: Joi.number().integer(),
            message: Joi.string()
          }),
        }
      },
      description: 'Create a new user',
      notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
        <p>Available to: <strong>admin</strong></p>',
      tags: ['user','auth','api'],
    }
  });

  server.route({
    method: 'PATCH',
    path: '/users/{id}',
    handler: function (request, reply) {

      //TODO - add code so that only admins and the user can do this.

      let query = { _id: new ObjectID(request.params.id) };

      db.collection(usersTable).findOne(query).then((result) => {
        if(!result) {
          return reply({ "statusCode": 400, "error": "Bad request", 'message': 'No record found for id: ' + request.params.id }).code(400);
        }

        //Trying to change the username?
        if (request.payload.username != result.username) {

          let usernameQuery = { username: request.payload.username};
          //check if username already exists for a different account
          db.collection(usersTable).findOne(usernameQuery).then((usernameResult) => {

            if (usernameResult) {
              return reply({ "statusCode": 422, 'message': 'Username already exists' }).code(422);
            }

            let user = request.payload;

            if(request.payload.password) {
              let password = request.payload.password;

              Bcrypt.genSalt(saltRounds, (err, salt) => {
                Bcrypt.hash(password, salt, (err, hash) => {
                  user.password = hash;

                  db.collection(usersTable).update(query, { $set: user }).then(() => {
                    return reply().code(204);
                  }).catch((err) => {
                    console.log("ERROR:", err);
                    return reply().code(503);
                  });
                });
              });
            } else {
              db.collection(usersTable).update(query, { $set: user }).then(() => {
                return reply().code(204);
              }).catch((err) => {
                console.log("ERROR:", err);
                return reply().code(503);
              });
            }
          }).catch((err) => {
            console.log("ERROR:", err);
            return reply().code(503);
          });
        } else {

          let user = request.payload;

          if(request.payload.password) {
            let password = request.payload.password;

            Bcrypt.genSalt(saltRounds, (err, salt) => {
              Bcrypt.hash(password, salt, (err, hash) => {
                user.password = hash;

                db.collection(usersTable).update(query, { $set: user }).then(() => {
                  return reply().code(204);
                }).catch((err) => {
                  console.log("ERROR:", err);
                  return reply().code(503);
                });
              });
            });
          } else {
            db.collection(usersTable).update(query, { $set: user }).then(() => {
              return reply().code(204);
            }).catch((err) => {
              console.log("ERROR:", err);
              return reply().code(503);
            });
          }
        }  
      }).catch((err) => {
        throw err;
      });
    },
    config: {
      auth: {
        strategy: 'jwt',
        // scope: 'admin'
      },
      validate: {
        headers: {
          authorization: Joi.string().required()
        },
        params: Joi.object({
          id: Joi.string().length(24).required()
        }),
        payload: Joi.object({
          username: Joi.string().min(1).max(100).optional(),
          fullname: Joi.string().min(1).max(100).optional(),
          system_user: Joi.boolean(),
          email: Joi.string().email().optional(),
          password: Joi.string().allow('').max(50).optional(),
          roles: Joi.array().items(Joi.string()).min(1).optional(),
        }).required().min(1),
        options: {
          allowUnknown: true
        }
      },
      response: {
        status: {
          400: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
          401: Joi.object({
            statusCode: Joi.number().integer(),
            error: Joi.string(),
            message: Joi.string()
          }),
        }
      },
      description: 'Update a user record',
      notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
        <p>Available to: <strong>admin</strong></p>',
      tags: ['user','auth','api'],
    }
  });

  server.route({
    method: 'DELETE',
    path: '/users/{id}',
    handler: function (request, reply) {

      //Can't delete yourself
      if (request.params.id === request.auth.credentials.id) {
        return reply({ "statusCode": 400, "error": "Bad request", 'message': 'Cannot delete yourself' }).code(400);
      }

      let query = { _id: new ObjectID(request.params.id) };

      db.collection(usersTable).findOne(query).then((result) => {
        if(!result) {
          return reply({ "statusCode": 404, 'message': 'No record found for id: ' + request.params.id }).code(404);
        }

        if(result.system_user && !request.auth.credentials.scope.includes('admin')) {
          return reply({ 'statusCode': 422, 'error': 'Forbidden', 'message': 'User does not have privledges to delete system accounts' }).code(404); 
        }

        db.collection(usersTable).deleteOne(query).then((result) => {
          return reply(result).code(204);
        }).catch((err) => {
          console.log("ERROR:", err);
          return reply().code(503);
        });
      }).catch((err) => {
        console.log("ERROR:", err);
        return reply().code(503);
      });
    },
    config: {
      auth: {
        strategy: 'jwt',
        scope: ['admin', 'event_manager']
      },
      validate: {
        headers: {
          authorization: Joi.string().required()
        },
        params: Joi.object({
          id: Joi.string().length(24).required()
        }),
        options: {
          allowUnknown: true
        }
      },
      description: 'Delete a user record',
      notes: '<p>Requires authorization via: <strong>JWT token</strong></p>\
        <p>Available to: <strong>admin</strong></p>',
      tags: ['user','auth','api'],
    }
  });

  server.route({
    method: 'GET',
    path: '/users/{id}/token',
    handler: function (request, reply) {

      if(request.auth.credentials.id == request.params.id || request.auth.credentials.scope.includes('admin')) {

        db.collection(usersTable).findOne({ _id: new ObjectID(request.params.id) }, (err, result) => {

          if (err) {
            console.log("ERROR:", err);
            return reply().code(503);
          }

          if (!result) {
            return reply().code(401);
          }

          let user = result;

          return reply({ token: Jwt.sign( { id:user._id, scope: user.roles}, SECRET_KEY ) }).code(200);
        });
      } else {
        return reply({"statusCode":403,"error":"Forbidden","message":"Insufficient scope"}).code(403);
      }
    },
    config: {
      auth: {
        strategy: 'jwt',
        //scope: ['admin']
      },
      validate: {
        params: {
          id: Joi.string().length(24).required()
        }
      },
      response: {
        status: {
          200: Joi.object({
            token: Joi.string().regex(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*$/),
          }),
        }
      },
      description: 'This is the route used for retrieving a user\'s JWT based on the user\'s ID.',
      notes: '<div class="panel panel-default">\
        <div class="panel-heading"><strong>Status Code: 200</strong> - authenication successful</div>\
        <div class="panel-body">Returns JSON object conatining user information</div>\
      </div>\
      <div class="panel panel-default">\
        <div class="panel-heading"><strong>Status Code: 401</strong> - authenication failed</div>\
        <div class="panel-body">Returns nothing</div>\
      </div>',
      tags: ['login', 'auth', 'api']
    }
  });

  return next();
};

exports.register.attributes = {
  name: 'routes-api-users',
  dependencies: ['hapi-mongodb']
};
