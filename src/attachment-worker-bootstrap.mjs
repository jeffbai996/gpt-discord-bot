// A JavaScript bootstrap installs the tsx hook before Node resolves the
// TypeScript worker entry point. Worker threads do not consistently apply an
// inherited --import hook to their entry module across supported Node builds.
import { register } from 'tsx/esm/api'

register()
await import('./attachment-worker.ts')
