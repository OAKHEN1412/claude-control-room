// Point the server data dir at a fixture folder (it holds our-styles.json) unless a test or the shell chose one.
import path from 'node:path';

if (!process.env.CR_DATA_DIR) process.env.CR_DATA_DIR = path.join(__dirname, 'fixtures', 'data');
