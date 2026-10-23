// Node.js-only entry point for @meddleware/walrus-storage-client. Re-exports utilities that require
// Node.js filesystem or other server-side APIs. Browser bundlers importing from the main
// entry point (".") will not see these imports.
//
// Usage: import { uploadLocalFile } from '@meddleware/walrus-storage-client/node'

export { uploadLocalFile } from './upload.js'
