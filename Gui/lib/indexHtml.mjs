import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
