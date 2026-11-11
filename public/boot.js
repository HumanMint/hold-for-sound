// The page's first script. It imports nothing, so it runs even when another script fails to load (a
// network error, or a browser holding an old copy). If the page has not started a few seconds after
// loading, the banner says so, with the browser's own error, instead of keeping its placeholder.
let error = '';
// Capturing: a script that fails to load fires its error on its own element, and it does not bubble.
addEventListener('error', (e) => (error ||= e.message || (e.target?.src ? `${e.target.src.split('/').pop()} did not load.` : '')), true);
addEventListener('load', () => setTimeout(() => {
  if ('started' in document.documentElement.dataset) return;
  document.getElementById('word').textContent = "Didn't load";
  document.getElementById('then').textContent = `Reload the page.${error ? ` ${error}` : ''}`;
}, 6000));
