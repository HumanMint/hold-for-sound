// A polite line to a free upstream service: jobs run one at a time with a gap after each,
// and once the line is full new callers are turned away instead of piling up.
export function queue(gapMs, max = 8) {
  let tail = Promise.resolve();
  let waiting = 0;
  return (job) => {
    if (waiting >= max) return Promise.reject(Object.assign(new Error('Busy. Try again in a few seconds.'), { status: 429, retryAfter: 5 }));
    waiting++;
    const result = tail.then(job);
    tail = result
      .then(() => {}, () => {})
      .then(() => new Promise((done) => setTimeout(done, gapMs)))
      .then(() => waiting--);
    return result;
  };
}
