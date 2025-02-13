const {
  eventsTable
} = require('../config/db_constants');

exports.plugin = {
  name: 'db_populate_events',
  dependencies: ['hapi-mongodb'],
  register: async (server, options) => {

    const db = server.mongo.db;
    const ObjectID = server.mongo.ObjectID;

    const test_data = [
      {
        _id: new ObjectID('5981f167212b348aed7fa9f5'),
        event_author: 'admin',
        ts: new Date("2017/06/14 19:01:00Z"),
        event_value: "FISH",
        event_options: [{
          event_option_name: "status",
          event_option_value: "alive"
        }],
        event_free_text: "some free text"
      }, {
        _id: new ObjectID('5981f167212b348aed7fa9f6'),
        event_author: 'user',
        ts: new Date("2017/06/14 19:11:00Z"),
        event_value: "CORAL",
        event_options: [{
          event_option_name: "status",
          event_option_value: "alive"
        }],
        event_free_text: "some more text"
      }, {
        _id: new ObjectID('5981f167212b348aed7fa9f7'),
        event_author: 'user',
        ts: new Date("2017/06/14 19:21:00Z"),
        event_value: "FISH",
        event_options: [{
          event_option_name: "status",
          event_option_value: "alive"
        }],
        event_free_text: "some other text"
      }, {
        _id: new ObjectID('5981f167212b348aed7fa9f8'),
        event_author: 'admin',
        ts: new Date("2017/06/14 19:31:00Z"),
        event_value: "FISH",
        event_options: [{
          event_option_name: "status",
          event_option_value: "alive"
        }],
        event_free_text: "some misc text"
      }, {
        _id: new ObjectID('5981f167212b348aed7fa9f9'),
        event_author: 'admin',
        ts: new Date("2017/06/14 19:41:00Z"),
        event_value: "FISH",
        event_options: [{
          event_option_name: "status",
          event_option_value: "dead"
        }],
        event_free_text: "some free text"
      }
    ];

    console.log("Searching for Events Collection");
    try {
      const result = await db.listCollections({ name: eventsTable }).toArray();
      if (result.length > 0) {
        console.log("Events Collection is present... dropping it");
        try {
          await db.dropCollection(eventsTable);
        }
        catch (err) {
          console.log("DROP ERROR:", err.code);
          throw (err);
        }
      }
    }
    catch (err) {
      console.log("LIST ERROR:", err.code);
      throw (err);
    }

    try {
      console.log("Creating Events Collection");
      const collection = await db.createCollection(eventsTable);

      console.log("Populating Events Collection");
      await collection.insertMany(test_data);

    }
    catch (err) {
      console.log("CREATE ERROR:", err.code);
      throw (err);
    }
  }
};