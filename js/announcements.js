import { t, getCurrentLang } from './i18n.js';
import { DISCORD_SVG } from './apply.js';

// Announcements — a read-only mirror of the official Creature Club Discord announcements
// channel. The server (/api/announcements) hands us already-shaped, host-checked rows;
// the bot only ever pushes that one channel's top-level posts, so edits update in place
// (never a second card), deletes drop off, and thread replies never arrive here.
//
// Everything the server sends is treated as untrusted text: content is escaped first,
// then a small, safe subset of Discord markdown is layered back on. No raw string is
// ever inserted as HTML, and every generated URL (emoji, avatars, images) is built from
// digit-only ids or host-checked links, so the feed can't smuggle markup or off-site img.

const root = () => document.getElementById('announcements-app');

let data = null;      // /api/announcements payload | { error } | null while loading
let revealed = false; // entrance animation plays once

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- dates ---

function fmtFull(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(getCurrentLang(), {
      dateStyle: 'long', timeStyle: 'short',
    });
  } catch { return new Date(iso).toLocaleString(); }
}

// "just now" / "3h ago" / "2 days ago", localized, falling back to a date for old posts.
function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  try {
    const rtf = new Intl.RelativeTimeFormat(getCurrentLang(), { numeric: 'auto' });
    if (sec < 45) return t('ann.time.now');
    const min = Math.round(sec / 60);
    if (min < 60) return rtf.format(-min, 'minute');
    const hr = Math.round(min / 60);
    if (hr < 24) return rtf.format(-hr, 'hour');
    const day = Math.round(hr / 24);
    if (day < 7) return rtf.format(-day, 'day');
    // Older than a week — a plain date reads better than "3 weeks ago".
    return new Date(iso).toLocaleDateString(getCurrentLang(), { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return fmtFull(iso); }
}

// --- safe Discord-flavored markdown ---

// A NUL delimiter wraps extracted tokens (code, links) so later regex passes never
// touch them; they are swapped back for their built HTML at the very end. NUL never
// appears in Discord message text.
const MARK = String.fromCharCode(0); // token delimiter — never appears in Discord text

function fmtDiscordTs(unix, style) {
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const lang = getCurrentLang();
  try {
    switch (style) {
      case 't': return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      case 'T': return d.toLocaleTimeString(lang);
      case 'd': return d.toLocaleDateString(lang, { day: '2-digit', month: '2-digit', year: 'numeric' });
      case 'D': return d.toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' });
      case 'R': return fmtRelative(d.toISOString());
      case 'F': return d.toLocaleString(lang, { dateStyle: 'full', timeStyle: 'short' });
      default:  return d.toLocaleString(lang, { dateStyle: 'long', timeStyle: 'short' });
    }
  } catch { return d.toISOString(); }
}

function renderContent(raw) {
  if (!raw) return '';
  const tokens = [];
  const stash = html => { tokens.push(html); return `${MARK}${tokens.length - 1}${MARK}`; };
  let s = String(raw);

  // 1. Fenced code blocks — captured from the RAW source, escaped once here.
  s = s.replace(/```(?:[a-zA-Z0-9+#.\-]*\n)?([\s\S]*?)```/g, (_, code) =>
    stash(`<pre class="ann-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`));
  // 2. Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code class="ann-code-inline">${esc(code)}</code>`));

  // 3. Escape everything that's left — from here on the string is HTML-safe text.
  s = esc(s);

  // 4. Markdown links [label](https://…) — label already escaped, url https-only.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    stash(`<a class="ann-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  // 5. Bare URLs (not already captured above).
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)])/g, (_, pre, url) =>
    `${pre}${stash(`<a class="ann-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);

  // 6. Custom emoji <:name:id> / <a:name:id> — id is digits only, so the CDN URL is safe.
  s = s.replace(/&lt;(a)?:(\w{2,32}):(\d{5,25})&gt;/g, (_, anim, name, id) =>
    `<img class="ann-emoji" src="https://cdn.discordapp.com/emojis/${id}.${anim ? 'gif' : 'png'}" alt=":${esc(name)}:" title=":${esc(name)}:" loading="lazy" />`);
  // 7. Discord timestamps <t:unix:style>.
  s = s.replace(/&lt;t:(\d{1,15})(?::([tTdDfFR]))?&gt;/g, (_, unix, style) =>
    `<time class="ann-ts">${esc(fmtDiscordTs(unix, style))}</time>`);
  // 8. Mentions — we don't resolve names, so render neutral pills. @everyone/@here stay as text.
  s = s.replace(/&lt;@!?(\d{5,25})&gt;/g, `<span class="ann-mention">${esc(t('ann.mention.user'))}</span>`);
  s = s.replace(/&lt;@&amp;(\d{5,25})&gt;/g, `<span class="ann-mention">${esc(t('ann.mention.role'))}</span>`);
  s = s.replace(/&lt;#(\d{5,25})&gt;/g, `<span class="ann-mention">${esc(t('ann.mention.channel'))}</span>`);

  // 9. Inline styling. Spoiler first so its content isn't eaten by other passes.
  s = s.replace(/\|\|([^\n]+?)\|\|/g, '<span class="ann-spoiler">$1</span>');
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^\n]+?)__/g, '<u>$1</u>');
  s = s.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^\*])\*([^\*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');

  // 10. Block structure, line by line: headings, blockquotes, bullet lists, paragraphs.
  const lines = s.split('\n');
  const out = [];
  let para = [], list = [], quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list.length) { out.push(`<ul class="ann-ul">${list.map(li => `<li>${li}</li>`).join('')}</ul>`); list = []; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote class="ann-quote">${quote.join('<br>')}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<div class="ann-mh ann-mh-${level}">${heading[2]}</div>`);
    } else if (bullet) {
      flushPara(); flushQuote();
      list.push(bullet[1]);
    } else if (bq) {
      flushPara(); flushList();
      quote.push(bq[1]);
    } else if (line.trim() === '') {
      flushAll();
    } else {
      flushList(); flushQuote();
      para.push(line);
    }
  }
  flushAll();
  let htmlOut = out.join('');

  // 11. Restore stashed tokens (they may sit inside <p>/<li>/… now).
  htmlOut = htmlOut.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => tokens[Number(i)] ?? '');
  return htmlOut;
}

// --- pieces ---

function avatarNode(author) {
  if (author.avatar) {
    return `<img class="ann-avatar" src="${esc(author.avatar)}" alt="" loading="lazy"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ann-avatar is-fallback',textContent:'📣','ariaHidden':'true'}))" />`;
  }
  return '<span class="ann-avatar is-fallback" aria-hidden="true">📣</span>';
}

function attachmentsNode(atts) {
  if (!atts?.length) return '';
  const images = atts.filter(a => a.type === 'image');
  const files = atts.filter(a => a.type === 'file');
  const imgGrid = images.length ? `
    <div class="ann-media ${images.length === 1 ? 'is-single' : 'is-grid'}">
      ${images.map(im => `
        <a class="ann-shot" href="${esc(im.url)}" target="_blank" rel="noopener noreferrer">
          <img src="${esc(im.url)}" alt="${esc(im.name || '')}" loading="lazy" />
        </a>`).join('')}
    </div>` : '';
  const fileList = files.length ? `
    <div class="ann-files">
      ${files.map(f => `
        <a class="ann-file" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">
          <span class="ann-file-ico" aria-hidden="true">📎</span>
          <span class="ann-file-name">${esc(f.name)}</span>
        </a>`).join('')}
    </div>` : '';
  return imgGrid + fileList;
}

function embedsNode(embeds) {
  if (!embeds?.length) return '';
  return embeds.map(e => `
    <div class="ann-embed">
      ${e.title ? (e.url
        ? `<a class="ann-embed-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>`
        : `<div class="ann-embed-title">${esc(e.title)}</div>`) : ''}
      ${e.description ? `<div class="ann-embed-desc">${renderContent(e.description)}</div>` : ''}
      ${e.image ? `<a class="ann-shot ann-embed-img" href="${esc(e.image)}" target="_blank" rel="noopener noreferrer"><img src="${esc(e.image)}" alt="" loading="lazy" /></a>` : ''}
    </div>`).join('');
}

function card(a, i) {
  const editedChip = a.editedAt
    ? `<span class="ann-edited" title="${esc(fmtFull(a.editedAt))}">${esc(t('ann.edited'))}</span>` : '';
  const content = a.content ? `<div class="ann-body">${renderContent(a.content)}</div>` : '';
  return `
    <article class="ann-card ${revealed ? 'is-static' : ''}" style="--i:${i}">
      <div class="apply-aurora" aria-hidden="true"></div>
      <header class="ann-head">
        ${avatarNode(a.author)}
        <div class="ann-meta">
          <span class="ann-author">${esc(a.author.name)}</span>
          <span class="ann-sub">
            <span class="ann-badge">${esc(t('ann.badge'))}</span>
            <time class="ann-when" datetime="${esc(a.postedAt || '')}" title="${esc(fmtFull(a.postedAt))}">${esc(fmtRelative(a.postedAt))}</time>
            ${editedChip}
          </span>
        </div>
      </header>
      ${content}
      ${attachmentsNode(a.attachments)}
      ${embedsNode(a.embeds)}
      <footer class="ann-foot">
        <a class="ann-discord-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">
          <span class="ann-discord-logo" aria-hidden="true">${DISCORD_SVG}</span>
          <span>${esc(t('ann.viewon'))}</span>
        </a>
      </footer>
    </article>`;
}

function channelCta(d) {
  if (!d.channelUrl) return '';
  return `
    <a class="apply-discord-btn ann-channel-btn" href="${esc(d.channelUrl)}" target="_blank" rel="noopener noreferrer">
      <span class="apply-discord-logo">${DISCORD_SVG}</span>
      <span class="apply-discord-label">${esc(t('ann.openchannel'))}</span>
      <span class="apply-discord-shine" aria-hidden="true"></span>
    </a>`;
}

function listView(d) {
  const list = d.announcements || [];
  if (!list.length) {
    return `
      <div class="ann-empty" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        <div class="ann-empty-ico" aria-hidden="true">📣</div>
        <h4>${esc(t('ann.empty.h'))}</h4>
        <p>${esc(t('ann.empty.p'))}</p>
        ${channelCta(d)}
      </div>`;
  }
  return `
    <div class="ann-topbar" data-reveal>
      <span class="ann-count">${esc(t('ann.count').replace('{n}', list.length))}</span>
      ${channelCta(d)}
    </div>
    <div class="ann-feed" data-reveal>
      ${list.map((a, i) => card(a, i)).join('')}
    </div>`;
}

function errorView() {
  return `
    <div class="ann-card ann-error" data-reveal>
      <p>${esc(t('ann.loaderr'))}</p>
      <button class="apply-btn-ghost" type="button" id="ann-retry">${esc(t('apply.retry'))}</button>
    </div>`;
}

function bind(el) {
  el.querySelector('#ann-retry')?.addEventListener('click', () => loadAnnouncements(true));
  // Spoilers reveal on click/enter.
  el.querySelectorAll('.ann-spoiler').forEach(sp => {
    sp.setAttribute('role', 'button');
    sp.setAttribute('tabindex', '0');
    const reveal = () => sp.classList.add('is-open');
    sp.addEventListener('click', reveal);
    sp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
  });
}

function render() {
  const el = root();
  if (!el || data === null) return;
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = data.error ? errorView() : listView(data);
  bind(el);
  if (!data.error) revealed = true;
}

export async function loadAnnouncements(showSpinner = true) {
  const el = root();
  if (!el) return;
  if (showSpinner) {
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>';
  }
  try {
    const res = await fetch('/api/announcements', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : { error: true };
  } catch {
    data = { error: true };
  }
  render();
}

// Re-render with cached data after a language switch (relative times + labels refresh).
export function rerenderAnnouncements() {
  if (data !== null) render();
}
