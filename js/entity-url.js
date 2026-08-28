// Codex addresses. Kept in their own file because the archive, the trait showcase and
// the codex itself all need to write these links, and only the codex should have to know
// how a page is rendered.
//
//   /collections/release/<release id>
//   /collections/item/<item name slug>
//   /collections/trait/<slot>/<value slug>
//   /collections/creature/<the number in its name>

// Names become path segments. Diacritics fold to ASCII so a URL survives being pasted
// through chat clients that mangle anything else. Checked against the whole archive: its
// 1,406 item names produce 1,406 distinct slugs, so no two items share a page.
export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

export function codexHref(kind, ...parts) {
  return `/collections/${kind}/${parts.map(slug).join('/')}`;
}
