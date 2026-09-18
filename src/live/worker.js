'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { Project } = require('./project');
const project = new Project(workerData.metadataPath);
let pending = null, running = false;
parentPort.on('message', async message => {
  // Only retain the newest waiting snapshot. Already-running work is allowed to
  // finish; the editor rejects it using a generation plus document versions.
  if (pending) parentPort.postMessage({ id: pending.id, superseded: true });
  pending = message;
  if (running) return;
  running = true;
  while (pending) {
    const request = pending; pending = null;
    const start = performance.now();
    try { parentPort.postMessage({ id: request.id, result: await project.run(request.request), analysisMs: performance.now() - start }); }
    catch (error) { parentPort.postMessage({ id: request.id, error: error.stack || error.message }); }
  }
  running = false;
});
