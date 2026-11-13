// Loaded after a test's own fetch stand-in: the runway table (server.js) never comes from the network
// in a test, and is never counted as one of its calls. TEST_RUNWAYS is the CSV to answer with.
// Weather is absent unless a test explicitly supplies its own forecast stand-in.
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).includes('/v1/forecast') && process.env.TEST_WEATHER !== '1' ? Promise.resolve(Response.json({})) : (String(url).includes('ourairports') ? Promise.resolve(new Response(process.env.TEST_RUNWAYS ?? '')) : fetch(url, options));
