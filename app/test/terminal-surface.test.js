const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cellBackground, paletteColor } = require('../renderer/terminal-surface')

test('edge colors use the actual RGB cell rather than changing the terminal theme', () => {
  const theme = {background:'#000000'}
  const cell = {isInverse:()=>false,getBgColor:()=>0x262626,isBgRGB:()=>true,isBgPalette:()=>false}
  assert.equal(cellBackground(cell,theme),'#262626')
  assert.deepEqual(theme,{background:'#000000'})
})
test('default and palette backgrounds match xterm color values', () => {
  assert.equal(cellBackground(null,{background:'#000000'}),'#000000')
  assert.equal(paletteColor(232,{}),'rgb(8,8,8)')
  assert.equal(paletteColor(196,{}),'rgb(255,0,0)')
})
