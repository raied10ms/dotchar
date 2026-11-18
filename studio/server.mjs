#!/usr/bin/env node
/** npm run studio  ->  http://localhost:8790/studio/  (static files + local lip-sync API; nothing leaves your machine except optional STT calls) */
import { startServer } from '../cli/serve.mjs';
const port = +(process.env.PORT || 8790);
await startServer(port);
console.log(`.char studio: http://localhost:${port}/studio/`);
