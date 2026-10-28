import { analyzeDocument } from './document-analysis.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ result: await analyzeDocument(data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
