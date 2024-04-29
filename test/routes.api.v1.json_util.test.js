const Lab = require('@hapi/lab');
const { expect } = require('@hapi/code');
const { describe, it } = exports.lab = Lab.script();
const { flattenEventJSON, convertToCSV, getHeaders } = require('../routes/api/v1/json_util');

describe('flattenEventJSON', () => {
  it('should correctly flatten JSON events', () => {
    const input = [
      {
        ts: "2023-10-14T10:10:10.000Z",
        id: '5d27973bd1848b7eb56fa85d',
        event_free_text: 'Some "event" text',
        event_options: [
          { event_option_name: "option1", event_option_value: "value1" }
        ],
        aux_data: []
      }
    ];
    const output = flattenEventJSON(input);

    expect(output).to.not.equal(null);
    expect(output.events[0]['event_option.option1']).to.equal("value1");
    expect(output.events[0].event_free_text).to.equal('Some "event" text');
    expect(output.events[0].ts).to.equal("2023-10-14T10:10:10.000Z");
    expect(output.events[0].id).to.equal('5d27973bd1848b7eb56fa85d');
  });
});

describe('convertToCSV', () => {
  it('should correctly convert an array of objects to CSV', () => {
    const input = [
      {
        key1: "value1",
        key2: "value2"
      },
      {
        key1: "value3",
        key2: "value4"
      }
    ];
    const csv = convertToCSV(input);
    const expectedCSV = 'key1,key2\n"value1","value2"\n"value3","value4"';

    expect(csv).to.equal(expectedCSV);
  });
});

describe('getHeaders', () => {
  it('should return an array of headers', () => {
   // Make sure an array of objects with different keys returns the correct headers

    const input = [
      {
        key1: "value1",
        key2: "value2"
      },
      {
        key2: "value3",
        key3: "value4"
      }
    ];
    
    const expected = ['key1', 'key2', 'key3'];
    const headers = getHeaders(input);
    expect(headers).to.equal(expected);
  });
});


describe('Integration Test with Provided Input Data', () => {
  const inputData = [
    {
      "event_value": "Dive Phase",
      "event_free_text": "",
      "event_options": [
        {
          "event_option_name": "phase",
          "event_option_value": "Bottom approach"
        }
      ],
      "ts": "2023-01-27T15:44:39.513Z",
      "event_author": "port",
      "aux_data": [
        {
          "data_source": "vehicleRealtimeNavData",
          "data_array": [
            {
              "data_name": "latitude",
              "data_value": "9.90565350",
              "data_uom": "ddeg"
            },
            {
              "data_name": "longitude",
              "data_value": "-104.29502410",
              "data_uom": "ddeg"
            },
            {
              "data_name": "local_x",
              "data_value": "545.78",
              "data_uom": "meters"
            },
            {
              "data_name": "local_y",
              "data_value": "4275.09",
              "data_uom": "meters"
            },
            {
              "data_name": "depth",
              "data_value": "2113.97",
              "data_uom": "meters"
            },
            {
              "data_name": "heading",
              "data_value": "133.85",
              "data_uom": "deg"
            },
            {
              "data_name": "pitch",
              "data_value": "-5.08",
              "data_uom": "deg"
            },
            {
              "data_name": "roll",
              "data_value": "-0.20",
              "data_uom": "deg"
            },
            {
              "data_name": "altitude",
              "data_value": "19.90",
              "data_uom": "meters"
            }
          ],
          "id": "63d3f167515dfa001a997b36"
        },
        {
          "data_source": "vehicleRealtimeFramegrabberData",
          "data_array": [
            {
              "data_name": "camera_name",
              "data_value": "port_brow_4k (Framegrabber 1)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20230127_154439513.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "port_brow_4k (Framegrabber 2)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/port_brow_4k.framegrab02/port_brow_4k.framegrab02.20230127_154439513.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "port_patz (Framegrabber 3)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/port_patz.framegrab03/port_patz.framegrab03.20230127_154439513.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "stbd_patz (Framegrabber 4)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/stbd_patz.framegrab04/stbd_patz.framegrab04.20230127_154439513.jpg"
            }
          ],
          "id": "63d3f168515dfa001a997b37"
        }
      ],
      "id": "63d3f167515dfa001a997b35"
    },
    {
      "event_value": "Dive Phase",
      "event_free_text": "",
      "event_options": [
        {
          "event_option_name": "phase",
          "event_option_value": "On bottom"
        }
      ],
      "ts": "2023-01-27T16:07:13.343Z",
      "event_author": "port",
      "aux_data": [
        {
          "data_source": "vehicleRealtimeNavData",
          "data_array": [
            {
              "data_name": "latitude",
              "data_value": "9.90559330",
              "data_uom": "ddeg"
            },
            {
              "data_name": "longitude",
              "data_value": "-104.29471260",
              "data_uom": "ddeg"
            },
            {
              "data_name": "local_x",
              "data_value": "579.95",
              "data_uom": "meters"
            },
            {
              "data_name": "local_y",
              "data_value": "4268.43",
              "data_uom": "meters"
            },
            {
              "data_name": "depth",
              "data_value": "2556.48",
              "data_uom": "meters"
            },
            {
              "data_name": "heading",
              "data_value": "41.51",
              "data_uom": "deg"
            },
            {
              "data_name": "pitch",
              "data_value": "-1.48",
              "data_uom": "deg"
            },
            {
              "data_name": "roll",
              "data_value": "0.25",
              "data_uom": "deg"
            },
            {
              "data_name": "altitude",
              "data_value": "4.95",
              "data_uom": "meters"
            }
          ],
          "id": "63d3f6b1515dfa001a997c47"
        },
        {
          "data_source": "vehicleRealtimeFramegrabberData",
          "data_array": [
            {
              "data_name": "camera_name",
              "data_value": "port_brow_4k (Framegrabber 1)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/port_brow_4k.framegrab01/port_brow_4k.framegrab01.20230127_160713343.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "port_brow_4k (Framegrabber 2)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/port_brow_4k.framegrab02/port_brow_4k.framegrab02.20230127_160713343.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "stbd_brow_4k (Framegrabber 3)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/stbd_brow_4k.framegrab03/stbd_brow_4k.framegrab03.20230127_160713343.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "stbd_brow_4k (Framegrabber 4)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/stbd_brow_4k.framegrab04/stbd_brow_4k.framegrab04.20230127_160713343.jpg"
            },
            {
              "data_name": "camera_name",
              "data_value": "brow_wide (Framegrabber 5)"
            },
            {
              "data_name": "filename",
              "data_value": "/Alvin-D5154/brow_wide.framegrab05/brow_wide.framegrab05.20230127_160713343.jpg"
            }
          ],
          "id": "63d3f6b2515dfa001a997c48"
        }
      ],
      "id": "63d3f6b1515dfa001a997c46"
    }
  ];

  it('should correctly flatten the input data', () => {
    const flattened = flattenEventJSON(inputData);

    // Ensure some basic expected properties are available in the result
    expect(flattened.events[0].event_value).to.equal("Dive Phase");
    expect(flattened.events[0]['event_option.phase']).to.equal("Bottom approach");
    expect(flattened.events[0]['vehicleRealtimeNavData.latitude (ddeg)']).to.equal("9.90565350");
  });

  it('should correctly convert the flattened data to CSV', () => {
    const { events, events_by_type } = flattenEventJSON(inputData);

    const csvEvents = convertToCSV(events);
    console.log(events_by_type)
    const csvAuxNavData = convertToCSV(events_by_type["Dive Phase"]);

    // Assert the headers for the events CSV
    expect(csvEvents.split('\n')[0]).to.include(["event_value","event_free_text"]);

    // Assert the headers for the vehicleRealtimeNavData CSV
    expect(csvAuxNavData.split('\n')[0]).to.include(["vehicleRealtimeNavData.latitude (ddeg)"]);
  });

});
