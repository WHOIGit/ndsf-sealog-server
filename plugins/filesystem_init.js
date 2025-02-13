const fs = require('fs/promises');
const path = require('path');

const {
  IMAGE_PATH,
  CRUISE_PATH,
  LOWERING_PATH
} = require('../config/path_constants');

exports.plugin = {
  name: 'filesystem_init',
  dependencies: [],
  register: async (options) => {
    const directories = [
      { path: IMAGE_PATH, name: 'Image' },
      { path: CRUISE_PATH, name: 'Cruise' },
      { path: LOWERING_PATH, name: 'Lowering' }
    ];

    for (const dir of directories) {
      console.log(`Searching for ${dir.name} Directory`);
      try {
        await fs.access(dir.path);
        console.log(`${dir.name} Directory found.`);
      } catch {
        console.log(`${dir.name} Directory not found... trying to create.`);
        try {
          await fs.mkdir(dir.path, { recursive: true });
          console.log(`${dir.name} Directory created`);
        } catch (err) {
          console.error(`Error creating ${dir.name} Directory:`, err);
        }
      }
    }
  }
};