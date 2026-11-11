// Loaded after a test's own fetch stand-in: the runway table (server.js) never comes from the network
// in a test, and is never counted as one of its calls. TEST_RUNWAYS is the CSV to answer with.
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => (String(url).includes('ourairports') ? Promise.resolve(new Response(process.env.TEST_RUNWAYS ?? '')) : fetch(url, options));
