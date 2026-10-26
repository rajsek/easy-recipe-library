/**
 * Zero-config entry for Vercel's Express support: Vercel looks for a default
 * export in root app/index/server files and requires the entrypoint to import
 * express itself. Local development keeps using `npm start`
 * (tsx server/index.ts), which is unchanged.
 */
import 'express';
import app from './server/index.js';

export default app;
