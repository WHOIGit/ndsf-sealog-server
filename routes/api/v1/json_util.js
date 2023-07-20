const archiver = require('archiver');
const { Writable } = require('stream');

const flattenJSON = (json) => {
  const eventsByType = {};

  const flatJSON = json.map((event) => {
    const copiedEvent = { ...event };

    if (!eventsByType[event.event_value])
      eventsByType[event.event_value] = [copiedEvent];
    else
      eventsByType[event.event_value].push(copiedEvent);

    copiedEvent.ts = new Date(copiedEvent.ts).toISOString();
    copiedEvent.event_options.forEach((data) => {
      copiedEvent['event_option.' + data.event_option_name] = data.event_option_value;
    });
    delete copiedEvent.event_options;

    if (copiedEvent.aux_data) {
      copiedEvent.aux_data.forEach((auxRow) => {
        auxRow.data_array.forEach((auxCol) => {
          auxColLabel = auxCol.data_name;
          // uom never changes, so just add to the label
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

const getHeaders = (arrayOfFlatJSON) => {
  const headers = new Set();
  arrayOfFlatJSON.forEach((obj) => {
    Object.keys(obj).forEach((key) => {
      headers.add(key);
    });
  });
  return Array.from(headers);
}

const convertToCSV = (arrayOfFlatJSON) => {
  const headers = getHeaders(arrayOfFlatJSON);
  const headerRow = headers.join(',');
  const rows = arrayOfFlatJSON.map(obj => headers.map(header => JSON.stringify(obj[header] || '')));
  return [headerRow, ...rows].join('\n');
};


const zipFiles = async (files) => {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip');
    const chunks = [];

    // Custom writable stream to collect chunks of data
    const bufferCollector = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });

    bufferCollector.on('finish', () => {
      console.log("Returning buffer chunks")
      resolve(Buffer.concat(chunks));
    });

    archive.on('error', (err) => {
      reject(err);
    });

    // Append files to the archive
    for (const file of files) {
      archive.append(file.data, { name: file.name });
    }

    // Pipe the archive data to the buffer collector
    archive.pipe(bufferCollector);

    // Finalize the archive
    archive.finalize();
  });
};

function sanitizeFilename(input) {
  // 1. Remove illegal characters
  var illegalChars = /[/\\?%*:|"<>]/g;  // These characters are not allowed in filenames on Windows and Unix systems.
  var sanitized = input.replace(illegalChars, "_");  // Replace illegal characters with underscores.
  
  // 2. Trim to maximum filename length (255 characters is a common maximum, but you can adjust as needed)
  var maxLength = 255;
  if (sanitized.length > maxLength) {
      sanitized = sanitized.substr(0, maxLength);
  }
  
  // 3. Replace spaces with underscores
  return sanitized.replace(/ /g, "_");
}

const flattenAndZip = async (jsonData, includeAux = true) => {
  try {
    // Flatten the JSON data
    const { events, events_by_type } = flattenJSON(jsonData);
    const eventsData = convertToCSV(events);

    // If events only, just return the events CSV
    if (!includeAux) return eventsData

    // Otherwise, aggregate the CSVs into a ZIP buffer
    const files = [{
      name: 'all_events.csv',
      data: eventsData
    }];

    // Append each events_by_type CSV to the archive
    for (const eventType in events_by_type) {
      files.push({
        name: `events_${sanitizeFilename(eventType)}.csv`,
        data: convertToCSV(events_by_type[eventType])
      });
    }

    // Return the ZIP buffer
    return await zipFiles(files);
  } catch (error) {
    console.error('Error during flatten/zip export:', error);
    throw error;
  }
};

exports.flattenAndZip = flattenAndZip;
exports.flattenJSON = flattenJSON;
exports.convertToCSV = convertToCSV;
exports.zipFiles = zipFiles;
exports.getHeaders = getHeaders;
exports.sanitizeFilename = sanitizeFilename;
