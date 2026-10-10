// Regressions for the three P0 layout bugs, pinned as source-level checks.
//
// Each one of these was a real defect that shipped and was invisible to the
// unit suite: the map vanished on a race, the grid orphaned a column, and the
// detail panel clipped its own buttons. The browser tools
// (tools/repro-map.mjs, tools/detail-panel-check.mjs, tools/layout-audit.mjs)
// measure them; these tests make the fix impossible to undo silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const radar = read('radar/radar.js');
const css = read('radar/radar.css');
const html = read('index.html');

// ── P0 1: the map must not depend on a race ───────────────────────────────
test('the cached scope layer is keyed on the contours actually being loaded', () => {
  const keyFn = radar.slice(radar.indexOf('function staticCacheKey'), radar.indexOf('function rebuildStatic'));
  assert.ok(keyFn.length > 0, 'staticCacheKey exists');
  // The first frame is built while the GeoJSON is still in flight. If the key
  // does not mention the contours, that contour-less disc is cached forever and
  // the map never appears — measured 8 of 20 reloads drawing it before the fix.
  assert.match(keyFn, /contourStatus/, 'key includes the contour load status');
  assert.match(keyFn, /state\.contours/, 'key includes the contour payload');
});

test('the contour loader starts idle, not loading', () => {
  // loadContours() guards on 'loading'. Seeding the state as 'loading' makes it
  // return before issuing the fetch, so the map is never drawn at all.
  assert.match(radar, /contourStatus:\s*'idle'/, 'initial status is idle');
  assert.doesNotMatch(radar, /contourStatus:\s*'loading',\s*\n\s*contourError/, 'initial status is not loading');
});

test('a failed contour load is reported and can be retried', () => {
  assert.match(radar, /contourStatus = 'error'/, 'errors are recorded');
  assert.match(radar, /renderMapState\(\)/, 'the state is re-rendered');
  assert.match(radar, /loadContours\(force = false\)/, 'retry forces a reload');
  assert.match(radar, /loadContours\(true\)/, 'the retry button re-fetches');
  // An empty GeoJSON is a failure, not a map with no outlines.
  assert.match(radar, /if \(!polys\.length\) throw/, 'an empty payload is treated as an error');
});

test('the scope never presents an empty disc as finished', () => {
  assert.match(radar, /contourStatus !== 'ready'/, 'the disc checks the contour status');
  assert.ok(html.includes('id="rlMapState"'), 'a status line exists in the markup');
  assert.match(css, /\.rl-map-state\[hidden\]\s*\{\s*display:\s*none/, 'the status line reserves no space when hidden');
});

test('the embed radar keys on the contours as well', () => {
  const embed = read('embed/radar/embed.js');
  assert.match(embed, /state\.contours\?\.length/, 'embed cache key includes the contour count');
});

// ── P0 2: no dead space from a mis-built grid ──────────────────────────────
test('the main layout uses independent columns, not row-coupled grid cells', () => {
  // In a grid every cell of a row is as tall as the tallest one, so adding the
  // detail panel below the radar left the settings and feed columns hanging in
  // mid-air with hundreds of pixels of nothing under them.
  const mainRule = css.slice(css.indexOf('.rl-main {'), css.indexOf('.rl-card {'));
  assert.match(mainRule, /display:\s*flex/, 'columns are independent flex stacks');
  assert.ok(!/grid-template-columns/.test(mainRule), 'no row-coupled grid on the main layout');
});

test('the radar and the detail panel share one column box', () => {
  const lines = html.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '<main class="rl-main">');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '</main>');
  assert.ok(start >= 0 && end > start, '<main> exists');
  const inside = lines.slice(start, end);
  // Depth is tracked by exact indentation so a nested </div> at a deeper level
  // cannot be mistaken for the column's own closer.
  const openAt = inside.findIndex((l) => l.trim() === '<div class="rl-col-b">');
  assert.ok(openAt >= 0, 'the middle column exists');
  const closeAt = inside.findIndex((l, i) => i > openAt && l === '  </div>');
  assert.ok(closeAt > openAt, 'the middle column is closed');

  const box = inside.slice(openAt, closeAt).join('\n');
  assert.ok(box.includes('id="radarCard"'), 'the radar is inside the middle column');
  assert.ok(box.includes('class="rl-detail-col"'), 'the detail panel is inside the middle column');
  assert.ok(!box.includes('class="rl-feed-col"'), 'the feed column is not inside the middle column');
  assert.ok(inside.join('\n').indexOf('class="rl-feed-col"') > inside.join('\n').indexOf('rl-col-b'), 'the feed column comes after');
});

test('narrow breakpoints unwrap the column instead of stacking it twice', () => {
  // `display: contents` dissolves the wrapper so the radar and the detail panel
  // become direct grid items again — otherwise the mobile layout would gain a
  // container the approved mockup never had.
  assert.match(css, /\.rl-col-b\s*\{\s*display:\s*contents/, 'the wrapper dissolves below the desktop breakpoint');
});

test('cards size to their content', () => {
  assert.doesNotMatch(css, /\.rl-card\s*\{[^}]*height:\s*100vh/, 'no viewport height on cards');
  assert.doesNotMatch(css, /\.rl-feed-col\s*\{[^}]*align-content:\s*stretch/, 'the feed column does not stretch');
  assert.match(css, /\.rl-feed-col\s*\{[^}]*align-content:\s*start/, 'the feed column aligns to the start');
});

// ── P0 3: the detail panel ────────────────────────────────────────────────
test('the detail panel is bounded and scrolls inside itself', () => {
  const rule = css.slice(css.indexOf('.rl-detail {'), css.indexOf('.rl-detail-close'));
  assert.match(rule, /display:\s*flex/, 'panel is a flex column');
  assert.match(rule, /max-height:\s*min\(/, 'panel height is capped against the viewport');
  assert.match(rule, /flex-direction:\s*column/, 'header and body stack');
  // Without min-height:0 the body refuses to shrink, overflows the capped
  // panel and the action buttons end up below the clipped edge — unreachable.
  assert.match(css, /\.rl-detail-body\s*\{[^}]*min-height:\s*0/, 'body may shrink so it can scroll');
  assert.match(css, /\.rl-detail-body\s*\{[^}]*overflow-y:\s*auto/, 'body scrolls');
  assert.match(css, /\.rl-detail-body\s*\{[^}]*overscroll-behavior:\s*contain/, 'scrolling does not chain to the page');
});

test('no breakpoint puts the panel back into an unbounded block', () => {
  // This override silently cancelled the flex column on every screen up to
  // 1700px, which is where the clipped buttons came from.
  assert.doesNotMatch(css, /\.rl-detail\s*\{\s*display:\s*block/, 'no display:block override survives');
});

test('the panel header carries the identity row', () => {
  const head = html.slice(html.indexOf('class="rl-detail-head"'), html.indexOf('id="rlDetailBody"'));
  assert.ok(head.includes('id="rlDetailIcon"'), 'the threat icon lives in the header');
  assert.ok(head.includes('id="rlDetailTitle"'), 'the title lives in the header');
  assert.ok(head.includes('id="rlDetailSev"'), 'severity lives in the header');
  assert.ok(head.includes('id="rlDetailSub"'), 'time and source live in the header');
  assert.ok(head.includes('id="rlDetailClose"'), 'the close button stays in the header');
  assert.match(radar, /function setDetailHead/, 'one helper paints the header for every opener');
  // No duplicated hero block above the scroll area.
  assert.doesNotMatch(radar, /rl-detail-hero/, 'the body no longer repeats the title block');
});

test('mobile turns the panel into a bottom sheet that keeps its close button', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 900px)'));
  const sheet = mobile.slice(mobile.indexOf('.rl-detail {'));
  assert.match(sheet, /position:\s*fixed/, 'anchored to the viewport');
  assert.match(sheet, /bottom:\s*calc\(/, 'sits above the safe area');
  assert.match(sheet, /max-height:\s*86dvh/, 'bounded to the visible height');
  // The sheet must not be a fixed wide panel that forces a horizontal scrollbar.
  assert.doesNotMatch(sheet, /min-width:\s*\d{3,}px/, 'no forced minimum width');
  assert.match(mobile, /\.rl-detail-close\s*\{[^}]*width:\s*38px/, 'the close target grows for touch');
});

test('the minimap cannot take over the panel', () => {
  assert.match(css, /\.rl-minimap\s*\{[^}]*max-width:\s*\d+px/, 'the minimap is capped');
});

// ── The empty radar must not stack text on text ──────────────────────────
test('the empty-state message owns a band the radar keeps clear', () => {
  // Drawn at the centre, it sat on the centre name and under any geocoded city
  // label — the reported collision.
  assert.match(radar, /export function emptyStateBox/, 'the band is computed, not guessed');
  assert.match(radar, /export function overlaps/, 'a shared collision test exists');
  assert.match(radar, /emptyStateBox\(cx, cy, R, dpr, emptyStateLines\(/,
    'the cached layer reserves the same band the message is drawn into');
  // The message is no longer placed on the centre name.
  const draw = radar.slice(radar.lastIndexOf('if (!pts.length)'));
  assert.doesNotMatch(draw.slice(0, 600), /cy \+ 26 \* dpr/, 'not on top of the centre name');
  assert.match(draw, /roundRect/, 'it has a backing plate');
});

test('city labels are dropped rather than struck through by the message', () => {
  const block = radar.slice(radar.indexOf('// city labels'), radar.indexOf('// Cardinal points'));
  assert.match(block, /overlaps\(labelBox, reserve\)/, 'a colliding label is skipped');
  assert.match(block, /continue;/, 'and the loop actually skips it');
});

test('the cached layer is rebuilt when the reserved band appears', () => {
  // City labels load from local cache before the first fetch, so the first
  // cached layer has no snapshot to reserve space against. Without this in the
  // key it would never be rebuilt and the labels would stay painted.
  const keyFn = radar.slice(radar.indexOf('function staticCacheKey'), radar.indexOf('function rebuildStatic'));
  assert.match(keyFn, /hasPlottedTargets\(/, 'key follows the empty/non-empty flip');
  assert.match(keyFn, /state\.snapshot \? 1 : 0/, 'key follows the first snapshot arriving');
});

test('the empty radar never claims everything is calm', () => {
  // Three genuinely different situations, none of them "no threats".
  assert.match(radar, /Очікування даних/, 'no data yet');
  assert.match(radar, /Немає підтверджених цілей — останні дані застаріли/, 'stale pipeline');
  assert.match(radar, /У цьому радіусі цілей немає/, 'nothing inside the radius');
  assert.match(radar, /Немає повідомлень із достатньо точними координатами/, 'no precise coordinates');
  assert.doesNotMatch(radar, /все спокійно|немає загроз|безпечно/i, 'never an unverified all-clear');
});

test('the mobile sheet has a backdrop and dismisses on tap', () => {
  assert.ok(html.includes('id="rlSheetScrim"'), 'the backdrop exists in the markup');
  assert.ok(html.includes('id="rlSheetScrim" hidden'), 'it ships hidden');
  assert.match(radar, /function setSheetOpen/, 'open state is managed in one place');
  assert.match(radar, /setSheetOpen\(true\)/, 'opening a threat shows the backdrop');
  assert.match(radar, /setSheetOpen\(false\)/, 'closing hides it again');
  assert.match(radar, /scrim\.onclick/, 'tapping it closes the sheet');
  // Hidden above the phone breakpoint, where the panel is an inline card and a
  // backdrop would dim the page for nothing.
  const base = css.slice(css.indexOf('.rl-sheet-scrim {'), css.indexOf('.rl-detail-empty'));
  assert.match(base, /\.rl-sheet-scrim\s*\{\s*display:\s*none/, 'no backdrop on wide screens');
});

test('the primary action stays reachable inside the panel', () => {
  // Scoped to the panel: the same button row is used in the settings sheet.
  assert.match(css, /\.rl-detail-body \.rl-btn-row\s*\{[^}]*position:\s*sticky/, 'actions dock to the panel foot');
});

// ── A class of bug the screenshots caught, not the numbers ────────────────
test('elements toggled with [hidden] can still be hidden', () => {
  // The user-agent `[hidden] { display: none }` rule loses to any author
  // `display` declaration. Giving the panel `display: flex` and the severity
  // chip `display: inline-block` therefore left both permanently visible: the
  // empty detail panel rendered on top of the "pick a threat" card. Every
  // element the script toggles with `hidden` must have an explicit escape.
  const toggled = [...radar.matchAll(/\$\('#([\w-]+)'\)\.hidden|\$\('#([\w-]+)'\)/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean);
  assert.ok(toggled.includes('detailCard'), 'detailCard is toggled with hidden');

  for (const cls of ['rl-detail', 'rl-sev', 'rl-map-state', 'rl-search-results']) {
    const setsDisplay = new RegExp(`\\.${cls}\\s*\\{[^}]*display:`).test(css);
    if (!setsDisplay) continue;
    assert.match(css, new RegExp(`\\.${cls}\\[hidden\\]`),
      `.${cls} sets display and must also define [hidden]`);
  }
});

test('the empty detail panel never shows next to the placeholder', () => {
  assert.ok(html.includes('id="detailCard"'), 'the panel exists');
  assert.match(html, /id="detailCard"[^>]*\bhidden\b/, 'it ships hidden');
  assert.match(css, /\.rl-detail\[hidden\]\s*\{\s*display:\s*none/, 'and the CSS keeps it hidden');
});

// ── The top bar is a site header, not an app tab bar ──────────────────────
test('the nav is a plain list of links', () => {
  const nav = html.slice(html.indexOf('<nav class="rl-nav"'), html.indexOf('</nav>'));
  assert.ok(nav.length > 0, 'the nav exists');
  assert.doesNotMatch(nav, /<svg/, 'no icons in the navigation');
  const labels = [...nav.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(labels, ['Радар', 'Події', 'Типи загроз', 'Джерела', 'Про проєкт', 'FAQ']);
  // The sections must stay reachable: the script drives them by data attributes.
  for (const attr of ['data-goto="radarCard"', 'data-goto="feedCard"', 'data-goto="threatTypes',
    'data-goto="sourcesCard"', 'data-href="./info/"', 'data-href="./info/#faq"']) {
    assert.ok(nav.includes(attr), `${attr} still wired`);
  }
});

test('the nav is not drawn as a segmented pill', () => {
  const rule = css.slice(css.indexOf('.rl-nav {'), css.indexOf('.rl-top-right'));
  assert.doesNotMatch(rule, /background:\s*var\(--surface\)/, 'no filled container behind the links');
  assert.doesNotMatch(rule, /border:\s*1px solid/, 'no border around the group');
  assert.doesNotMatch(rule, /border-radius:\s*11px/, 'no pill shape');
  assert.doesNotMatch(rule, /flex-direction:\s*column/, 'links are not stacked icon-over-label');
  // One signal for the active item, not a fill and an underline at once.
  // Read only the declaration block itself — the ::after underline legitimately
  // sets a background.
  const activeRule = css.slice(css.indexOf('.rl-nav button.active {'));
  assert.doesNotMatch(activeRule.slice(0, activeRule.indexOf('}') + 1), /background:/,
    'the active link is not filled');
  assert.match(activeRule, /\.rl-nav button\.active::after/, 'the active link is underlined');
});

test('the nav items divide the available width evenly', () => {
  const rule = css.slice(css.indexOf('.rl-nav {'), css.indexOf('.rl-nav button'));
  // Equal columns, not equal gaps: every item gets the same width, so the menu
  // fills the bar between the brand and the status cluster.
  assert.match(rule, /display:\s*grid/, 'the nav is a grid');
  assert.match(rule, /grid-template-columns:\s*repeat\(6,\s*1fr\)/, 'six equal columns');
  const item = css.slice(css.indexOf('.rl-nav button, .rl-nav a {'));
  assert.doesNotMatch(item.slice(0, 260), /flex:\s*none/, 'items are not content-width');
  assert.match(item.slice(0, 260), /text-align:\s*center/, 'labels are centred in their column');
  // The count must track the number of sections, or one column goes empty.
  const nav = html.slice(html.indexOf('<nav class="rl-nav"'), html.indexOf('</nav>'));
  const count = (nav.match(/<button/g) || []).length;
  const cols = css.match(/grid-template-columns:\s*repeat\((\d+),\s*1fr\)/);
  assert.ok(cols, 'column count is declared');
  assert.equal(Number(cols[1]), count, `columns (${cols[1]}) match nav items (${count})`);
});

test('the bar is sized by its own variable and anchors clear it', () => {
  const h = css.match(/--topbar-h:\s*(\d+)px/);
  assert.ok(h, '--topbar-h is defined');
  assert.ok(Number(h[1]) <= 64, `the bar is ${h[1]}px, not a double-height app bar`);
  assert.match(css, /\.rl-topbar\s*\{[^}]*min-height:\s*var\(--topbar-h\)/, 'the bar uses it');
  // Anchored jumps land under a sticky bar otherwise.
  assert.match(css, /scroll-margin-top:\s*calc\(var\(--topbar-h\)/, 'nav targets clear the sticky bar');
});