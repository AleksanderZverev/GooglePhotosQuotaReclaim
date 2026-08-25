// Production build only — esbuild inlines index.html as a string via --loader:.html=text
// In dev mode this file is never imported (indexHtml.mjs is used instead)
import INDEX_HTML_RAW from '../index.html';
export const INDEX_HTML = INDEX_HTML_RAW;
