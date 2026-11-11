// Aggregate activity for the operator, from visitors who switched sharing on. No IPs, typed queries,
// address names or audio are retained.
const DAY = 24 * 3600_000;
export function activity(clock = Date.now, max = 100) {
  const regions = new Map();
  const searches = new Map();
  // A place name from the proxy's header: letters, spaces and .'- only, or nothing. Node reads header
  // bytes as latin1, and the proxy sends UTF-8.
  const place = (value) => {
    const text = typeof value === 'string' ? Buffer.from(value, 'latin1').toString('utf8') : '';
    return /^[\p{L} .'-]{1,80}$/u.test(text) ? text : '';
  };
  function prune(rows, now) {
    for (const [key, row] of rows) if (now - row.first >= DAY) rows.delete(key);
  }
  function add(rows, key, values, now) {
    prune(rows, now);
    let row = rows.get(key);
    if (!row) {
      if (rows.size >= max) rows.delete(rows.keys().next().value);
      rows.set(key, row = { ...values, first: now, last: now, count: 0 });
    }
    row.last = now;
    row.count++;
    return row;
  }
  return {
    visit(headers, page) {
      const country = /^[A-Z]{2}$/.test(headers['x-hfs-country']) ? headers['x-hfs-country'] : 'Unknown';
      const city = place(headers['x-hfs-city']);
      const lat = headers['x-hfs-lat'] ? Number(headers['x-hfs-lat']) : NaN;
      const lon = headers['x-hfs-lon'] ? Number(headers['x-hfs-lon']) : NaN;
      const point = Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat: +lat.toFixed(1), lon: +lon.toFixed(1) } : {};
      const row = add(regions, JSON.stringify([country, city]), { country, city, ...point, pages: 0 }, clock());
      if (page) row.pages++;
    },
    search(status, hit) {
      const point = hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)
        ? { lat: +hit.lat.toFixed(2), lon: +hit.lon.toFixed(2) } : {};
      add(searches, JSON.stringify([status, point.lat, point.lon]), { status, ...point }, clock());
    },
    report() {
      const now = clock();
      prune(regions, now);
      prune(searches, now);
      return { now, retentionHours: 24, maxGroups: max, regions: [...regions.values()], searches: [...searches.values()] };
    },
  };
}
