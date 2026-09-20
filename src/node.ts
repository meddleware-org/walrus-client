// Node.js-only entry point for @meddleware/walrus-client. Re-exports utilities that require
// Node.js filesystem or other server-side APIs. Browser bundlers importing from the main
// entry point (".") will not see these imports.
//
// Usage: import { uploadLocalFile } from '@meddleware/walrus-client/node'

export { uploadLocalFile } from './upload.js'
