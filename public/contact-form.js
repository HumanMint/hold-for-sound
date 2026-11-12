// The contact form: a button in the footer and its dialog. Absent altogether unless the server has
// somewhere to send messages (GET api/contact). It posts only to this page's own server, which checks
// the message again and hands it on (contact.js there); nothing of it is kept in this browser.
// With a Turnstile site key from the server, Cloudflare's check is loaded when the dialog first opens,
// never before, and its token goes with the message.

import { said as saying, CHECK_MISSING, UNCHECKED, UNCONFIRMED, WAIT_MS } from './contact-core.js';

const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// Turnstile's script, loaded once: resolves with `turnstile`, or rejects when it cannot load.
let loading;
const turnstile = () => loading ??= new Promise((done, fail) => {
  const script = document.createElement('script');
  script.src = TURNSTILE;
  script.onload = () => (window.turnstile ? done(window.turnstile) : fail(new Error('no turnstile')));
  script.onerror = () => { loading = null; script.remove(); fail(new Error('turnstile did not load')); };
  document.head.append(script);
});

function build(sitekey) {
  document.querySelector('footer > p').insertAdjacentHTML('beforeend', ' <span class="contact-at">· <button type="button" class="quiet contact-open" aria-haspopup="dialog">Contact me</button></span>');
  document.body.insertAdjacentHTML(
    'beforeend',
    `<dialog id="contact" class="setup-dialog contact-dialog" aria-labelledby="contact-title">
      <div class="dialog-heading">
        <div><p class="eyebrow">Hold for Sound</p><h2 id="contact-title" tabindex="-1" autofocus>Contact me</h2></div>
        <button type="button" class="quiet contact-close">Close</button>
      </div>
      <form id="contact-form">
        <label>Name <input type="text" name="name" required minlength="2" maxlength="100" autocomplete="name"></label>
        <label>Email <input type="email" name="email" required maxlength="254" autocomplete="email"></label>
        <label>Category
          <select name="category" required>
            <option value="">Choose</option>
            <option value="feedback">Feedback</option>
            <option value="inquiry">Inquiry</option>
            <option value="general">General</option>
          </select></label>
        <label>Message <textarea name="message" required minlength="10" maxlength="5000" rows="7"></textarea></label>
        ${sitekey ? '<div class="contact-check"></div>' : ''}
        <div class="trap" aria-hidden="true"><label>leave this field empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
        <div class="contact-send"><button>Send</button><p id="contact-said" role="status"></p></div>
      </form>
    </dialog>`,
  );
  const dialog = document.getElementById('contact');
  const form = document.getElementById('contact-form');
  const said = document.getElementById('contact-said');
  const send = form.querySelector('.contact-send button');
  const box = form.querySelector('.contact-check');
  let widget; // the check's id once rendered; null when Turnstile could not load
  const showCheck = () => turnstile().then(
    (ts) => {
      widget ??= ts.render(box, {
        sitekey,
        action: 'contact',
        theme: 'auto',
        size: box.clientWidth < 300 ? 'compact' : 'flexible',
        'response-field': false,
      });
      if (said.textContent === CHECK_MISSING) said.textContent = '';
    },
    () => { widget = null; said.textContent = CHECK_MISSING; },
  );
  document.querySelector('.contact-open').addEventListener('click', () => {
    said.textContent = '';
    dialog.showModal();
    dialog.scrollTop = 0;
    if (sitekey && !widget) showCheck();
  });
  dialog.querySelector('.contact-close').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (send.getAttribute('aria-disabled') === 'true') return;
    const body = new URLSearchParams(new FormData(form));
    if (sitekey) {
      // No token, no send: the server would refuse it.
      if (widget == null) return showCheck();
      const token = window.turnstile.getResponse(widget);
      if (!token) return (said.textContent = UNCHECKED);
      body.set('cf-turnstile-response', token);
    }
    send.setAttribute('aria-disabled', 'true');
    said.textContent = 'Sending…';
    try {
      const res = await fetch('api/contact', { method: 'POST', body, signal: AbortSignal.timeout(WAIT_MS) });
      const answer = await res.json().catch(() => ({}));
      if (res.ok) form.reset();
      said.textContent = saying(res, answer);
    } catch {
      said.textContent = UNCONFIRMED; // no answer: it may have gone
    } finally {
      send.removeAttribute('aria-disabled');
      if (sitekey) window.turnstile.reset(widget); // a token is good for one send only
    }
  });
}

fetch('api/contact')
  .then((res) => res.ok && res.json())
  .then((contact) => contact?.on && build(typeof contact.sitekey === 'string' && contact.sitekey))
  .catch(() => {});
