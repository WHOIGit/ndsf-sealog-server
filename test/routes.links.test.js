'use strict';

const Lab = require('@hapi/lab');
const { expect } = require('@hapi/code');
const Glue = require('@hapi/glue');
const { afterEach, beforeEach, describe, it } = exports.lab = Lab.script();
const Manifest = require('../config/manifest');
const Jwt = require('jsonwebtoken');
const SECRET_KEY = require('../config/secret');
const { eventsTable, eventAuxDataTable, loweringsTable } = require('../config/db_constants');
const { internals } = require('../routes/links');

// Lowerings loaded by plugins/dbDevel_lowerings.js in NODE_ENV=test:
// 4928 is public (2017-06-14 18:00Z to 2017-06-15 02:00Z) inside public
// cruise AT37-14; 4930 is hidden, with user webb on its access list.
// AT29-02 (2015-06-17 to 2015-06-27) is a hidden cruise.
const publicLoweringID = '4928';
const hiddenLoweringID = '4930';
const hiddenCruiseLoweringID = 'LINKS-TEST-1';
const hiddenCruiseLoweringOID = '7a6981f167212b348aed7f01';
const webbID = '5981f167212b348aed7fd9f5';

const eventIDs = [
  '7a81f167212b348aed7fa901', // 20:00:00.437, port_brow_4k + brow_wide
  '7a81f167212b348aed7fa902', // 20:00:15.912, SciCam
  '7a81f167212b348aed7fa903', // 17:59:50, SciCam, before the lowering starts
  '7a81f167212b348aed7fa904', // 20:00:02.500, no framegrab
  '7a81f167212b348aed7fa905' // 21:00:00.000, port_brow_4k on framegrabbers 1 and 2
];
const auxIDs = ['7a7341898c1553258f703c01', '7a7341898c1553258f703c02', '7a7341898c1553258f703c03', '7a7341898c1553258f703c05'];

const asnap = (ObjectID, id, ts) => ({
  _id: new ObjectID(id),
  event_author: 'asnap',
  ts: new Date(ts),
  event_value: 'ASNAP',
  event_options: [],
  event_free_text: ''
});

const framegrabAux = (ObjectID, id, eventID, pairs) => ({
  _id: new ObjectID(id),
  event_id: new ObjectID(eventID),
  data_source: 'vehicleRealtimeFramegrabberData',
  data_array: pairs.flatMap(([cameraName, filename]) => [
    { data_name: 'camera_name', data_value: cameraName },
    { data_name: 'filename', data_value: filename }
  ])
});

const initStartedServer = async () => {

  const manifest = JSON.parse(JSON.stringify(Manifest));
  manifest.server.port = 0;

  const server = await Glue.compose(manifest, { relativeTo: __dirname + '/..' });
  await server.start();

  return server;
};

const insertFramegrabs = async (server) => {

  const db = server.mongo.db;
  const ObjectID = server.mongo.ObjectID;

  await db.collection(eventsTable).insertMany([
    asnap(ObjectID, eventIDs[0], '2017-06-14T20:00:00.437Z'),
    asnap(ObjectID, eventIDs[1], '2017-06-14T20:00:15.912Z'),
    asnap(ObjectID, eventIDs[2], '2017-06-14T17:59:50.000Z'),
    asnap(ObjectID, eventIDs[3], '2017-06-14T20:00:02.500Z'),
    asnap(ObjectID, eventIDs[4], '2017-06-14T21:00:00.000Z')
  ]);

  await db.collection(eventAuxDataTable).insertMany([
    framegrabAux(ObjectID, auxIDs[0], eventIDs[0], [
      ['port_brow_4k (Framegrabber 1)', '/4928/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20170614_200000437.jpg'],
      ['brow_wide (Framegrabber 3)', '/4928/brow_wide.framegrab03/brow_wide.framegrab03.20170614_200000437.jpg']
    ]),
    framegrabAux(ObjectID, auxIDs[1], eventIDs[1], [
      ['SciCam', '/4928/SciCam/SciCam..20170614_200015912.jpg']
    ]),
    framegrabAux(ObjectID, auxIDs[2], eventIDs[2], [
      ['SciCam', '/4928/SciCam/SciCam..20170614_175950000.jpg']
    ]),
    framegrabAux(ObjectID, auxIDs[3], eventIDs[4], [
      ['port_brow_4k (Framegrabber 1)', '/4928/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20170614_210000000.jpg'],
      ['port_brow_4k (Framegrabber 2)', '/4928/port_brow_4k.framegrab02/port_brow_4k.framegrab02.20170614_210000000.jpg']
    ])
  ]);

  // A public lowering inside hidden cruise AT29-02.
  await db.collection(loweringsTable).insertOne({
    _id: new ObjectID(hiddenCruiseLoweringOID),
    lowering_id: hiddenCruiseLoweringID,
    start_ts: new Date('2015-06-21T12:00:00Z'),
    stop_ts: new Date('2015-06-21T18:00:00Z'),
    lowering_additional_meta: {},
    lowering_location: '',
    lowering_tags: [],
    lowering_hidden: false
  });
};

const removeFramegrabs = async (server) => {

  const db = server.mongo.db;
  const ObjectID = server.mongo.ObjectID;

  await db.collection(eventsTable).deleteMany({ _id: { $in: eventIDs.map((id) => new ObjectID(id)) } });
  await db.collection(eventAuxDataTable).deleteMany({ _id: { $in: auxIDs.map((id) => new ObjectID(id)) } });
  await db.collection(loweringsTable).deleteOne({ _id: new ObjectID(hiddenCruiseLoweringOID) });
};

const tokenFor = async (server, userID) => {

  const user = await server.mongo.db.collection('users').findOne({ _id: new server.mongo.ObjectID(userID) });
  return Jwt.sign({ id: user._id, scope: server.methods._rolesToScope(user.roles), roles: user.roles }, SECRET_KEY);
};

describe('links internals', () => {

  it('parses compact and ISO timestamps', () => {

    expect(internals.parseTimestamp('20250210_183242').toISOString()).to.equal('2025-02-10T18:32:42.000Z');
    expect(internals.parseTimestamp('20250210_183242956').toISOString()).to.equal('2025-02-10T18:32:42.956Z');
    expect(internals.parseTimestamp('2025-02-10T18:32:42Z').toISOString()).to.equal('2025-02-10T18:32:42.000Z');
    expect(internals.parseTimestamp('2025-02-10T13:32:42.5-05:00').toISOString()).to.equal('2025-02-10T18:32:42.500Z');
    expect(internals.parseTimestamp('yesterday')).to.be.null();
    expect(internals.parseTimestamp('20251310_183242')).to.be.null();
  });

  it('reads an ISO time with no offset as UTC', () => {

    expect(internals.parseTimestamp('2025-02-10T18:32:42').toISOString()).to.equal('2025-02-10T18:32:42.000Z');
  });

  it('refuses dates that do not exist instead of rolling them over', () => {

    expect(internals.parseTimestamp('20250230_120000')).to.be.null();
    expect(internals.parseTimestamp('20250210_240000')).to.be.null();
    expect(internals.parseTimestamp('2025-02-30T12:00:00Z')).to.be.null();
    expect(internals.parseTimestamp('2025-02-10T24:00:00Z')).to.be.null();
  });

  it('breaks ties by the earlier event, then the lower id', () => {

    const events = [
      { _id: 'b', ts: new Date(2000) },
      { _id: 'c', ts: new Date(0) },
      { _id: 'a', ts: new Date(0) },
      { _id: 'd', ts: new Date(1500) }
    ];

    expect(events.sort(internals.byNearness(new Date(1000))).map((event) => event._id)).to.equal(['d', 'a', 'c', 'b']);
  });

  it('accepts every name a camera has been given', () => {

    const aliases = internals.cameraAliases('port_brow_4k (Framegrabber 1)',
      '/Alvin-D5295/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20250210_183242956.jpg');

    expect([...aliases]).to.include(['port_brow_4k', 'port_brow_4k.framegrab01', 'port_brow_4k (framegrabber 1)']);
    expect([...internals.cameraAliases('SubSea1', '/Alvin-D5050/SubSea1/SubSea1.20190801_120000123.jpg')]).to.equal(['subsea1']);
  });

  it('builds image paths relative to the requested route', () => {

    expect(internals.imagePath('/J2-1511/SciCam/SciCam..20230801_120000123.jpg', 4))
      .to.equal('../../../../files/images/J2-1511/SciCam/SciCam..20230801_120000123.jpg');
  });
});

describe('GET /sealog-server/links/images/{lowering_id}/{camera}/{timestamp}', () => {
  let server;

  beforeEach(async () => {

    server = await initStartedServer();
    await insertFramegrabs(server);
  });

  afterEach(async () => {

    await removeFramegrabs(server);
    await server.stop();
  });

  it('redirects a whole-second time to the framegrab with its milliseconds', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/port_brow_4k/20170614_200000`);

    expect(res.statusCode).to.equal(302);
    expect(res.headers.location).to.equal('../../../../files/images/4928/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20170614_200000437.jpg');
  });

  it('matches the camera by directory or full camera name', async () => {

    const byDir = await server.inject(`/sealog-server/links/images/${publicLoweringID}/brow_wide.framegrab03/20170614_200001?format=json`);
    expect(byDir.statusCode).to.equal(200);
    expect(byDir.result.filename).to.equal('/4928/brow_wide.framegrab03/brow_wide.framegrab03.20170614_200000437.jpg');

    const byName = await server.inject(`/sealog-server/links/images/${publicLoweringID}/${encodeURIComponent('Brow_Wide (Framegrabber 3)')}/20170614_200001?format=json`);
    expect(byName.statusCode).to.equal(200);
    expect(byName.result.camera_name).to.equal('brow_wide (Framegrabber 3)');
  });

  it('picks the nearest frame for the requested camera and reports the offset', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/SciCam/20170614_200002?format=json`);

    expect(res.statusCode).to.equal(200);
    expect(res.result.event_id).to.equal(eventIDs[1]);
    expect(res.result.delta_seconds).to.equal(13.912);
    expect(res.result.image_path).to.equal('../../../../files/images/4928/SciCam/SciCam..20170614_200015912.jpg');
    expect(res.result.server_path).to.equal('/sealog-server/files/images/4928/SciCam/SciCam..20170614_200015912.jpg');
  });

  it('accepts an ISO time with no offset as UTC', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/port_brow_4k/2017-06-14T20:00:00`);

    expect(res.statusCode).to.equal(302);
    expect(res.headers.location).to.equal('../../../../files/images/4928/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20170614_200000437.jpg');
  });

  it('responds 409 when a short camera name covers more than one camera', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/port_brow_4k/20170614_210000`);

    expect(res.statusCode).to.equal(409);
    expect(res.result.message).to.include(['port_brow_4k.framegrab01', 'port_brow_4k.framegrab02']);

    const second = await server.inject(`/sealog-server/links/images/${publicLoweringID}/port_brow_4k.framegrab02/20170614_210000`);
    expect(second.statusCode).to.equal(302);
    expect(second.headers.location).to.equal('../../../../files/images/4928/port_brow_4k.framegrab02/port_brow_4k.framegrab02.20170614_210000000.jpg');
  });

  it('ignores frames outside the lowering', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/SciCam/20170614_180000`);

    expect(res.statusCode).to.equal(404);
  });

  it('responds 400 for a tolerance over the limit', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/SciCam/20170614_200002?tolerance=601`);

    expect(res.statusCode).to.equal(400);
  });

  it('responds 404 when no frame is within the tolerance', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/SciCam/20170614_200002?tolerance=5`);

    expect(res.statusCode).to.equal(404);
  });

  it('responds 404 for an unknown camera or lowering', async () => {

    const camera = await server.inject(`/sealog-server/links/images/${publicLoweringID}/AftCam/20170614_200000`);
    expect(camera.statusCode).to.equal(404);

    const lowering = await server.inject('/sealog-server/links/images/NOPE-1/SciCam/20170614_200000');
    expect(lowering.statusCode).to.equal(404);
  });

  it('responds 400 for a malformed timestamp', async () => {

    const res = await server.inject(`/sealog-server/links/images/${publicLoweringID}/SciCam/last-tuesday`);

    expect(res.statusCode).to.equal(400);
  });

  it('refuses hidden lowerings to anonymous users', async () => {

    const res = await server.inject(`/sealog-server/links/images/${hiddenLoweringID}/SciCam/20170622_200000`);

    expect(res.statusCode).to.equal(401);
  });

  it('lets a user on the access list resolve a hidden lowering', async () => {

    const res = await server.inject({
      url: `/sealog-server/links/images/${hiddenLoweringID}/SciCam/20170622_200000`,
      headers: { authorization: await tokenFor(server, webbID) }
    });

    // Authorized, so the lowering is searched; it has no framegrabs.
    expect(res.statusCode).to.equal(404);
  });

  it('refuses a public lowering inside a hidden cruise to anonymous users', async () => {

    const res = await server.inject(`/sealog-server/links/images/${hiddenCruiseLoweringID}/SciCam/20150621_130000`);

    expect(res.statusCode).to.equal(401);
  });
});
