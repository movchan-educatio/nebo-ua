import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const styles = fs.readFileSync(new URL('../assets/css/styles.css', import.meta.url), 'utf8')

test('mobile topbar uses fixed side tracks and a shrinkable LIVE track', () => {
  const mobile = styles.match(/@media\(max-width:600px\)\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(mobile, /\.app-header\{[\s\S]*?display:grid/)
  assert.match(mobile, /grid-template-columns:auto minmax\(0,1fr\) auto/)
  assert.match(mobile, /\.header-center\{[^}]*min-width:0/)
  assert.match(mobile, /\.header-center \.live-pill\{[^}]*text-overflow:ellipsis/)
  assert.match(mobile, /\.header-actions\{[^}]*gap:6px/)
  assert.match(mobile, /\.header-actions \.icon-btn\{width:38px;height:38px/)
  assert.doesNotMatch(mobile, /margin-left:-|margin-right:-/)
})

test('mobile map controls respect both safe areas and keep equal right controls', () => {
  const mobile = styles.match(/@media\(max-width:600px\)\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(mobile, /--rail-left:max\(12px,env\(safe-area-inset-left,0px\)\)/)
  assert.match(mobile, /--rail-right:max\(12px,env\(safe-area-inset-right,0px\)\)/)
  assert.match(mobile, /\.map-hud,\.hud-expand\{left:var\(--rail-left\)\}/)
  assert.match(mobile, /\.map-controls\{right:var\(--rail-right\)\}/)
  assert.match(styles, /@media\(max-width:719px\)[\s\S]*?\.map-view\{--rail-btn:40px\}/)
  assert.match(styles, /@media\(max-width:719px\)[\s\S]*?\.map-btn\{width:40px;height:40px\}/)
  assert.doesNotMatch(mobile, /\.bottom-nav/)
})

test('only the secondary clock hides on the narrowest phones', () => {
  assert.match(styles, /@media\(max-width:359px\)\{\s*\.header-center time\{display:none\}\s*\}/)
  assert.doesNotMatch(styles, /\.live-pill\s*\{\s*display:none/)
})

test('flow stats adapt to the HUD panel width, not the viewport', () => {
  // The embed iframe is narrower than standalone at the same viewport,
  // so the 3-cell grid must respond to its container (container queries).
  assert.match(styles, /\.map-hud\{container-type:inline-size;container-name:hud\}/)
  assert.match(styles, /@container hud \(max-width:279px\)\{[\s\S]*?\.flow-stat svg\.flow-ico\{width:18px;height:18px\}/)
  assert.match(styles, /@container hud \(max-width:239px\)\{[\s\S]*?\.flow-stat svg\.flow-ico\{width:16px;height:16px\}/)
  assert.match(styles, /\.flow-cells\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/)
  const cq = styles.match(/@container hud \(max-width:239px\)\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(cq, /\.flow-stat\{[^}]*overflow:hidden/)
  assert.match(cq, /\.flow-stat i\{[^}]*text-overflow:ellipsis/)
  assert.doesNotMatch(cq, /position:\s*absolute/)
})
