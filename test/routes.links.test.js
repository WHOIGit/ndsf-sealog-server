'use strict';

const Lab = require('@hapi/lab');
const { expect } = require('@hapi/code');
const Glue = require('@hapi/glue');
const { afterEach, beforeEach, describe, it } = exports.lab = Lab.script();
const Manifest = require('../config/manifest');
const { eventsTable, eventAuxDataTable } = require('../config/db_constants');
const { internals } = require('../routes/links');

// Lowerings loaded by plugins/dbDevel_lowerings.js in NODE_ENV=test:
// 4928 is public (2017-06-14 18:00Z to 2017-06-15 02:00Z) inside public
// cruise AT37-14; 4930 is hidden.
const publicLoweringID = '4928';
const publicLoweringOID = '6981f167212b348aed7fa9f5';
const hiddenLoweringID = '4930';

const eventIDs = ['7a81f167212b348aed7fa901', '7a81f167212b348aed7fa902'];
const auxIDs = ['7a7341898c1553258f703c01', '7a7341898c1553258f703c02'];

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
    {
      _id: new ObjectID(eventIDs[0]),
      event_author: 'asnap',
      ts: new Date('2017-06-14T20:00:00.437Z'),
      event_value: 'ASNAP',
      event_options: [],
      event_free_text: ''
    },
    {
      _id: new ObjectID(eventIDs[1]),
      event_author: 'asnap',
      ts: new Date('2017-06-14T20:00:15.912Z'),
      event_value: 'ASNAP',
      event_options: [],
      event_free_text: ''
    }
  ]);

  await db.collection(eventAuxDataTable).insertMany([
    {
      _id: new ObjectID(auxIDs[0]),
      event_id: new ObjectID(eventIDs[0]),
      data_source: 'vehicleRealtimeFramegrabberData',
      data_array: [
        { data_name: 'camera_name', data_value: 'port_brow_4k (Framegrabber 1)' },
        { data_name: 'filename', data_value: '/4928/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20170614_200000437.jpg' },
        { data_name: 'camera_name', data_value: 'brow_wide (Framegrabber 3)' },
        { data_name: 'filename', data_value: '/4928/brow_wide.framegrab03/brow_wide.framegrab03.20170614_200000437.jpg' }
      ]
    },
    {
      _id: new ObjectID(auxIDs[1]),
      event_id: new ObjectID(eventIDs[1]),
      data_source: 'vehicleRealtimeFramegrabberData',
      data_array: [
        { data_name: 'camera_name', data_value: 'SciCam' },
        { data_name: 'filename', data_value: '/4928/SciCam/SciCam..20170614_200015912.jpg' }
      ]
    }
  ]);
};

const removeFramegrabs = async (server) => {

  const db = server.mongo.db;
  const ObjectID = server.mongo.ObjectID;

  await db.collection(eventsTable).deleteMany({ _id: { $in: eventIDs.map((id) => new ObjectID(id)) } });
  await db.collection(eventAuxDataTable).deleteMany({ _id: { $in: auxIDs.map((id) => new ObjectID(id)) } });
};

describe('links internals', () => {

  it('parses compact and ISO timestamps', () => {

    expect(internals.parseTimestamp('20250210_183242').toISOString()).to.equal('2025-02-10T18:32:42.000Z');
    expect(internals.parseTimestamp('20250210_183242956').toISOString()).to.equal('2025-02-10T18:32:42.956Z');
    expect(internals.parseTimestamp('2025-02-10T18:32:42Z').toISOString()).to.equal('2025-02-10T18:32:42.000Z');
    expect(internals.parseTimestamp('yesterday')).to.be.null();
    expect(internals.parseTimestamp('20251310_183242')).to.be.null();
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
});

describe('GET /sealog-server/links/lowerings/{lowering_id}', () => {
  let server;
  const savedClientURL = process.env.SEALOG_CLIENT_URL;

  beforeEach(async () => {

    server = await initStartedServer();
  });

  afterEach(async () => {

    if (savedClientURL === undefined) {
      delete process.env.SEALOG_CLIENT_URL;
    }
    else {
      process.env.SEALOG_CLIENT_URL = savedClientURL;
    }

    await server.stop();
  });

  it('returns the client path as JSON when no client URL is configured', async () => {

    delete process.env.SEALOG_CLIENT_URL;
    const res = await server.inject(`/sealog-server/links/lowerings/${publicLoweringID}`);

    expect(res.statusCode).to.equal(200);
    expect(res.result.id).to.equal(publicLoweringOID);
    expect(res.result.client_path).to.equal(`lowering_gallery/${publicLoweringOID}`);
  });

  it('redirects to the requested client view', async () => {

    process.env.SEALOG_CLIENT_URL = 'https://example.org/sealog-alvin';
    const res = await server.inject(`/sealog-server/links/lowerings/${publicLoweringID}?view=map`);

    expect(res.statusCode).to.equal(302);
    expect(res.headers.location).to.equal(`https://example.org/sealog-alvin/lowering_map/${publicLoweringOID}`);
  });

  it('responds 404 for an unknown lowering and 401 for a hidden one', async () => {

    const missing = await server.inject('/sealog-server/links/lowerings/NOPE-1');
    expect(missing.statusCode).to.equal(404);

    const hidden = await server.inject(`/sealog-server/links/lowerings/${hiddenLoweringID}`);
    expect(hidden.statusCode).to.equal(401);
  });
});
