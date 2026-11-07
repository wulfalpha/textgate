import { renameCandidates } from './rename-links.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ files: await renameCandidates(data) }); }
  catch (error) { self.postMessage({ error: error?.message ?? String(error) }); }
};
