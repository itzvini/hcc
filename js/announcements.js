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
let openId = null;    // the announcement a permalink asked for, or null for the feed
let single = null;    // one fetched by id, for a post that has scrolled off the feed

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

// Drop a leading line that's nothing but Discord pings (the "@role @role" / "@everyone"
// header ping most announcements open with). Website readers aren't being pinged, so it's
// pure noise up top. Only the first such line is removed; real content is untouched.
// A run of pings at the very start of the post. Only at the start: a ping inside a
// sentence names someone and belongs in the text.
const LEADING_PINGS = /^(?:\s*(?:<@[!&]?\d+>|<#\d+>|@everyone|@here))+\s*/;

function stripLeadingPingLine(raw) {
  let lines = String(raw).split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (lines.length) {
    const rest = lines[0].replace(LEADING_PINGS, '').trim();
    // The club's posts usually open "<@&role> <@&role> ## Heading" on ONE line. Dropping
    // the line whole took the heading with it; keeping it whole left the heading mid-line,
    // where the markdown pass can't see it, so "## Heading" printed as text.
    if (rest === '') lines.shift();
    else lines[0] = rest;
  }
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
}

function renderContent(raw, mentions = {}, { stripLeadingPings = false } = {}) {
  if (!raw) return '';
  const tokens = [];
  const stash = html => { tokens.push(html); return `${MARK}${tokens.length - 1}${MARK}`; };
  let s = stripLeadingPings ? stripLeadingPingLine(String(raw)) : String(raw);
  if (!s) return '';

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
  // 8. Mentions — resolve to real names from the server-supplied map (member = the
  // person's SERVER display name, which is what matches their Highrise username). Falls
  // back to a neutral pill when an id isn't in the map. @everyone/@here stay as text.
  const pill = (id, kind) => {
    const name = mentions[String(id)]?.name || '';
    if (kind === 'channel') {
      return name ? `<span class="ann-mention is-channel">#${esc(name)}</span>`
                  : `<span class="ann-mention is-channel">${esc(t('ann.mention.channel'))}</span>`;
    }
    if (name) return `<span class="ann-mention">@${esc(name)}</span>`;
    return `<span class="ann-mention">${esc(kind === 'role' ? t('ann.mention.role') : t('ann.mention.user'))}</span>`;
  };
  s = s.replace(/&lt;@!?(\d{5,25})&gt;/g, (_, id) => pill(id, 'user'));
  s = s.replace(/&lt;@&amp;(\d{5,25})&gt;/g, (_, id) => pill(id, 'role'));
  s = s.replace(/&lt;#(\d{5,25})&gt;/g, (_, id) => pill(id, 'channel'));

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
  const fallback = '<span class="ann-avatar is-fallback" aria-hidden="true"><img src="/img/ui/megaphone.png" alt="" /></span>';
  if (author.avatar) {
    // onerror is a double-quoted attribute, so the JS string uses single quotes
    // and every double quote in the fallback markup becomes &quot; for the parser.
    const onerr = `this.outerHTML='${fallback.replace(/"/g, '&quot;')}'`;
    return `<img class="ann-avatar" src="${esc(author.avatar)}" alt="" loading="lazy" onerror="${onerr}" />`;
  }
  return fallback;
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

function embedsNode(embeds, mentions) {
  if (!embeds?.length) return '';
  return embeds.map(e => `
    <div class="ann-embed">
      ${e.title ? (e.url
        ? `<a class="ann-embed-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>`
        : `<div class="ann-embed-title">${esc(e.title)}</div>`) : ''}
      ${e.description ? `<div class="ann-embed-desc">${renderContent(e.description, mentions || {})}</div>` : ''}
      ${e.image ? `<a class="ann-shot ann-embed-img" href="${esc(e.image)}" target="_blank" rel="noopener noreferrer"><img src="${esc(e.image)}" alt="" loading="lazy" /></a>` : ''}
    </div>`).join('');
}

// Every card carries its own address. The path is built by the server and handed over in
// the feed, so the browser never derives a second version of it that could drift.
function permalink(a) {
  return a.path || `/announcements/${encodeURIComponent(a.id)}`;
}

function card(a, i, { single = false } = {}) {
  const editedChip = a.editedAt
    ? `<span class="ann-edited" title="${esc(fmtFull(a.editedAt))}">${esc(t('ann.edited'))}</span>` : '';
  const rendered = a.content ? renderContent(a.content, a.mentions || {}, { stripLeadingPings: true }) : '';
  const content = rendered ? `<div class="ann-body">${rendered}</div>` : '';
  return `
    <article class="ann-card ${revealed ? 'is-static' : ''}" style="--i:${i}">
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="ann-head">
        ${avatarNode(a.author)}
        <div class="ann-meta">
          <span class="ann-author">${esc(a.author.name)}</span>
          <span class="ann-sub">
            <span class="ann-badge">${esc(t('ann.badge'))}</span>
            <a class="ann-when" href="${esc(permalink(a))}" title="${esc(t('ann.permalink'))}">
              <time datetime="${esc(a.postedAt || '')}">${esc(fmtRelative(a.postedAt))}</time>
            </a>
            ${editedChip}
          </span>
        </div>
      </div>
      ${content}
      ${attachmentsNode(a.attachments)}
      ${embedsNode(a.embeds, a.mentions)}
      <div class="ann-foot">
        <a class="ann-discord-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">
          <span class="ann-discord-logo" aria-hidden="true">${DISCORD_SVG}</span>
          <span>${esc(t('ann.viewon'))}</span>
        </a>
        <span class="ann-foot-links">
          ${single ? '' : `<a class="ann-permalink" href="${esc(permalink(a))}">${esc(t('ann.open'))}</a>`}
          <button class="ann-copy" type="button" data-copy="${esc(permalink(a))}">${esc(t('ann.copy'))}</button>
        </span>
      </div>
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

// An announcement is worth showing only if it renders SOMETHING: body text (after the
// ping-line strip), an image/file, or an embed. Guards against blank cards from messages
// that carry no displayable content (e.g. a forward we couldn't unwrap, or a ping-only post).
function hasRenderable(a) {
  const body = a.content ? renderContent(a.content, a.mentions || {}, { stripLeadingPings: true }) : '';
  return !!(body || (a.attachments && a.attachments.length) || (a.embeds && a.embeds.length));
}

function listView(d) {
  const list = (d.announcements || []).filter(hasRenderable);
  if (!list.length) {
    return `
      <div class="ann-empty" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        <div class="ann-empty-ico" aria-hidden="true"><img src="/img/ui/megaphone.png" alt="" /></div>
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

// One announcement on its own page. The feed is still the whole payload, so the
// neighbours either side come free and reading through the club's posts in order works
// the same way it does on a release page in the archive.
function singleView(d) {
  const list = (d.announcements || []).filter(hasRenderable);
  const at = list.findIndex(a => String(a.id) === String(openId));
  // Older than the feed's window, but the server found it. No neighbours to offer, since
  // the posts either side of it are not loaded either.
  if (at < 0 && single && String(single.id) === String(openId) && hasRenderable(single)) {
    if (location.pathname !== permalink(single)) history.replaceState(null, '', permalink(single));
    return `
      <div class="ann-topbar" data-reveal>
        <a class="ann-back" href="/announcements">${esc(t('ann.back'))}</a>
        ${channelCta(d)}
      </div>
      <div class="ann-feed is-single" data-reveal>${card(single, 0, { single: true })}</div>`;
  }
  if (at < 0) {
    return `
      <div class="ann-empty" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        <div class="ann-empty-ico" aria-hidden="true"><img src="/img/ui/megaphone.png" alt="" /></div>
        <h4>${esc(t('ann.gone.h'))}</h4>
        <p>${esc(t('ann.gone.p'))}</p>
        <a class="apply-btn-ghost ann-back" href="/announcements">${esc(t('ann.back'))}</a>
      </div>`;
  }
  const a = list[at];
  // Land the readable address in the bar, whichever form was asked for: a bare id, or a
  // slug from before the post was edited. The id resolved it either way.
  const canonical = permalink(a);
  if (location.pathname !== canonical) history.replaceState(null, '', canonical);
  // The feed is newest first, so the one before this in the list is the newer post.
  const newer = list[at - 1];
  const older = list[at + 1];
  const step = (item, isNewer) => `
    <a class="ann-step${isNewer ? ' is-newer' : ''}" href="${esc(permalink(item))}">
      <span class="ann-step-dir">${esc(t(isNewer ? 'ann.newer' : 'ann.older'))}</span>
      <span class="ann-step-t">${esc(item.title || fmtFull(item.postedAt))}</span>
    </a>`;
  return `
    <div class="ann-topbar" data-reveal>
      <a class="ann-back" href="/announcements">${esc(t('ann.back'))}</a>
      ${channelCta(d)}
    </div>
    <div class="ann-feed is-single" data-reveal>
      ${card(a, 0, { single: true })}
    </div>
    ${(newer || older) ? `<nav class="ann-steps" data-reveal aria-label="${esc(t('ann.nearby'))}">
      ${newer ? step(newer, true) : ''}${older ? step(older, false) : ''}
    </nav>` : ''}`;
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
  // Copy the whole address, not the path: what gets pasted has to work in Discord.
  el.querySelectorAll('.ann-copy').forEach(btn => btn.addEventListener('click', async () => {
    const url = location.origin + btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = t('ann.copied');
      btn.classList.add('is-done');
      setTimeout(() => { btn.textContent = t('ann.copy'); btn.classList.remove('is-done'); }, 1800);
    } catch {
      // Clipboard refused (an insecure origin, or the reader said no). Select it instead,
      // so copying by hand is one keystroke rather than a retype.
      const box = document.createElement('input');
      box.value = url; box.className = 'ann-copy-fallback';
      btn.after(box); box.select();
    }
  }));
  // Spoilers reveal on click/enter.
  el.querySelectorAll('.ann-spoiler').forEach(sp => {
    sp.setAttribute('role', 'button');
    sp.setAttribute('tabindex', '0');
    const reveal = () => sp.classList.add('is-open');
    sp.addEventListener('click', reveal);
    sp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
  });
}

// The tab keeps its heading on a single post, because the post is still part of that
// section. Only the lead steps aside: "every announcement, mirrored here" describes the
// feed, and above one post it describes something the reader is not looking at.
function setIntro(hidden) {
  const panel = document.getElementById('panel-announcements');
  panel?.querySelectorAll('[data-ann-intro]').forEach(n => { n.hidden = hidden; });
}

function render() {
  const el = root();
  if (!el || data === null) return;
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = data.error ? errorView() : openId ? singleView(data) : listView(data);
  bind(el);
  setIntro(!!openId && !data.error);
  if (!data.error) revealed = true;
  // A shared link should arrive with the post's own name in the tab, not the feed's.
  if (!data.error && openId) {
    const one = (data.announcements || []).find(a => String(a.id) === String(openId)) || single;
    if (one && one.title) {
      const site = document.querySelector('meta[property="og:site_name"]')?.content || '';
      document.title = site ? `${one.title} · ${site}` : one.title;
    }
  }
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

// Open one announcement, or the feed when id is null. Called by the router on every
// /announcements address, including back and forward.
export async function openAnnouncement(id) {
  const next = id ? String(id) : null;
  const changed = next !== openId;
  openId = next;
  if (data === null) { await loadAnnouncements(); }      // the feed answers most links
  else if (changed) render();
  if (!openId || data?.error) return;
  const inFeed = (data.announcements || []).some(a => String(a.id) === String(openId));
  if (inFeed || (single && String(single.id) === String(openId))) return;
  // Not in the feed's window. The server can still find it, and until it answers the
  // reader sees the "not here" card rather than a spinner over the whole tab.
  try {
    const res = await fetch(`/api/announcements/${encodeURIComponent(openId)}`,
      { headers: { Accept: 'application/json' } });
    single = res.ok ? (await res.json()).announcement : null;
  } catch { single = null; }
  if (single) render();
}
