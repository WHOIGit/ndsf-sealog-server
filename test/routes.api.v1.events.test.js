'use strict';

const Lab = require('@hapi/lab');
const { expect } = require('@hapi/code');
const Glue = require('@hapi/glue');
const { afterEach, beforeEach, describe, it } = exports.lab = Lab.script();
const Manifest = require('../config/manifest');

// Loaded by plugins/dbDevel_lowerings.js in NODE_ENV=test. This lowering's
// fixture events are FISH/CORAL only, so filtering for ASNAP should be empty.
const publicLowering4928ID = '6981f167212b348aed7fa9f5';
const missingEventValue = 'ASNAP';

const initStartedServer = async () => {

  const manifest = JSON.parse(JSON.stringify(Manifest));
  manifest.server.port = 0;

  const server = await Glue.compose(manifest, { relativeTo: __dirname + '/..' });
  await server.start();

  return server;
};

describe('GET /sealog-server/api/v1/events/bylowering/{id}', () => {
  let server;

  beforeEach(async () => {
    server = await initStartedServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds with an empty array when the lowering exists but no events match', async () => {
    const res = await server.inject({
      method: 'get',
      url: `/sealog-server/api/v1/events/bylowering/${publicLowering4928ID}?value=${missingEventValue}`
    });

    expect(res.statusCode).to.equal(200);
    expect(res.result).to.equal([]);
  });
});
