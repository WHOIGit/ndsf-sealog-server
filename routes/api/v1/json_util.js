const { Writable } = require('stream');

/**
 * The following prefix lists determine the preferred order for
 * columns in the CSV output. The first element in the list is
 * the most preferred, and the last element is the least preferred.
 * 
 * Note that it will search by prefix, so all columns with the same
 * prefix will be ordered together.
 */
const PREFIX_ORDERING_REALTIME = [
  "ts",
  "vehicleRealtimeNavData.latitude (ddeg)",
  "vehicleRealtimeNavData.longitude (ddeg)",
  "event",
  "vehicleRealtime",
  "vehicleReNav",
  "id"
];
const PREFIX_ORDERING_RENAV = [
  "ts",
  "vehicleReNavData.latitude (ddeg)",
  "vehicleReNavData.longitude (ddeg)",
  "event",
  "vehicleReNav",
  "vehicleRealtime",
  "id"
];

const flattenEventJSON = (json) => {
  const eventsByType = {};

  const flatJSON = json.map((event) => {
    const copiedEvent = { ...event };

    // Populate dictionary of event types
    if (!eventsByType[event.event_value])
      eventsByType[event.event_value] = [copiedEvent];
    else
      eventsByType[event.event_value].push(copiedEvent);

    // Convert timestamp to ISO string
    copiedEvent.ts = new Date(copiedEvent.ts).toISOString();

    // Flatten event_options onto the copied event
    copiedEvent.event_options.forEach((data) => {
      copiedEvent['event_option.' + data.event_option_name] = data.event_option_value;
    });
    delete copiedEvent.event_options;

    // Flatten aux_data onto the copied event
    if (copiedEvent.aux_data) {
      copiedEvent.aux_data.forEach((auxRow) => {

        // Create a dictionary of column names to track duplicates
        const colDict = {}
        auxRow.data_array.forEach((auxCol, idx) => {
          if (colDict[auxCol.data_name]) {
            colDict[auxCol.data_name].count += 1;
          } else {
            colDict[auxCol.data_name] = {
              count: 1,
              position: 1
            }
          }
        });

        auxRow.data_array.forEach((auxCol) => {

          // Add position to column label if there are multiple columns with the same name
          let auxColLabel = `${auxRow.data_source}.${auxCol.data_name}`;
          if (colDict[auxCol.data_name].count > 1) {
            const position = colDict[auxCol.data_name].position++;
            auxColLabel += `_${position}`;
          }

          // uom never changes, so just add it to the column heading
          if (auxCol.data_uom)
            auxColLabel += ` (${auxCol.data_uom})`;
          copiedEvent[auxColLabel] = auxCol.data_value;
        });
      });
      delete copiedEvent.aux_data;
    }

    return copiedEvent;
  });

  return { events: flatJSON, events_by_type: eventsByType };
};

const getHeaders = (flattenedEvents) => {
  // Collect all headers from the array of flat JSON objects
  const headers = new Set();
  flattenedEvents.forEach((event) => {
    Object.keys(event).forEach((key) => {
      headers.add(key);
    });
  });
  return Array.from(headers)
}

const orderHeaders = (headers, prefix_order) => {
  // Sort headers according to how they are ordered in the prefix_order list
  const orderedHeaders = [];
  for (let prefix of prefix_order) {
    const prefixHeaders = headers.filter(header => header.startsWith(prefix));
    orderedHeaders.push(...prefixHeaders);

    // Remove headers that have already been added to avoid duplication
    headers = headers.filter(header => !header.startsWith(prefix));
  }

  // Any headers that don't start with one of the prefixes will be added to the end
  return orderedHeaders.concat(headers);
}

const convertToCSV = (flattenedEvents, useRenav=false) => {
  const unordered = getHeaders(flattenedEvents);
  const headers = orderHeaders(unordered, useRenav ? PREFIX_ORDERING_RENAV : PREFIX_ORDERING_REALTIME);
  const rows = flattenedEvents.map(event => headers.map(header => JSON.stringify(event[header] || '')));

  // Special case 1: Rename 'ts' to 'Date/Time (UTC)'
  const tsIndex = headers.indexOf('ts');
  if (tsIndex !== -1) {
    headers[tsIndex] = 'Date/Time (UTC)';
  }

  // Special case 2: Ensure 'id' column is at the end
  const idIndex = headers.indexOf('id');
  if (idIndex !== -1) {
    headers.push(headers.splice(idIndex, 1)[0]);
    rows.forEach(row => row.push(row.splice(idIndex, 1)[0]));
  }

  // Special case 3: Only use realtime or renav for long, lat, alt, depth and heading
  const excludePrefix = useRenav ? 'vehicleRealtimeNavData.' : 'vehicleReNavData.';
  const prefixes = ['latitude', 'longitude', 'heading', 'depth', 'altitude'].map(prop => excludePrefix + prop);
  // Find indices of realtime or renav columns to exclude from CSV and splice them out
  prefixes.forEach(prefix => {
    const colIndex = headers.findIndex(header => header.startsWith(prefix));
    if (colIndex !== -1) {
      headers.splice(colIndex, 1);
      rows.forEach(row => row.splice(colIndex, 1));
    }
  });

  return [headers.join(','), ...rows].join('\n');
};

exports.flattenEventJSON = flattenEventJSON;
exports.convertToCSV = convertToCSV;
exports.getHeaders = getHeaders;
