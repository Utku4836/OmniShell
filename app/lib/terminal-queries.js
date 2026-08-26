const TERMINAL_COLORS = {
  0: '000000',
  1: 'ff5a45',
  2: '7ed99b',
  3: 'e6bd68',
  4: '86a9ef',
  5: 'c58be5',
  6: '68c6d8',
  7: 'c8c2bf',
  8: '6c625e',
  9: 'ff806e',
  10: 'a2f2bb',
  11: 'ffd98a',
  12: 'abc5ff',
  13: 'e0aff8',
  14: '8de3f3',
  15: 'ffffff'
}

function rgbResponse(hex) {
  const parts = hex.match(/.{2}/g) || ['00', '00', '00']
  return `rgb:${parts.map((part) => part + part).join('/')}`
}

function incompleteQuerySuffix(value) {
  const lastOsc = value.lastIndexOf('\u001b]')
  const lastBell = value.lastIndexOf('\u0007')
  const lastStringTerminator = value.lastIndexOf('\u001b\\')
  if (lastOsc > lastBell && lastOsc > lastStringTerminator) return value.slice(lastOsc)

  const csi = value.match(/\u001b\[[0-9;?]*$/)
  return csi ? csi[0] : ''
}

function collectTerminalResponses(previousBuffer, data, cols, rows, pixelWidth = cols * 9, pixelHeight = rows * 18) {
  const input = `${previousBuffer || ''}${data || ''}`
  const responses = []

  if (input.includes('\u001b[14t')) responses.push(`\u001b[4;${pixelHeight};${pixelWidth}t`)
  if (input.includes('\u001b[16t')) {
    const cellHeight = Math.max(1, Math.round(pixelHeight / rows))
    const cellWidth = Math.max(1, Math.round(pixelWidth / cols))
    responses.push(`\u001b[6;${cellHeight};${cellWidth}t`)
  }
  if (input.includes('\u001b[18t')) responses.push(`\u001b[8;${rows};${cols}t`)

  const paletteQuery = /\u001b\]4;(\d+);\?(?:\u0007|\u001b\\)/g
  for (const match of input.matchAll(paletteQuery)) {
    const color = TERMINAL_COLORS[Number(match[1])] || TERMINAL_COLORS[0]
    responses.push(`\u001b]4;${match[1]};${rgbResponse(color)}\u0007`)
  }

  const dynamicColorQuery = /\u001b\](10|11|12);\?(?:\u0007|\u001b\\)/g
  for (const match of input.matchAll(dynamicColorQuery)) {
    const color = match[1] === '11' ? TERMINAL_COLORS[0] : (match[1] === '12' ? 'ff6427' : 'e8e4e2')
    responses.push(`\u001b]${match[1]};${rgbResponse(color)}\u0007`)
  }

  return {
    buffer: incompleteQuerySuffix(input).slice(-256),
    responses: [...new Set(responses)]
  }
}

module.exports = { collectTerminalResponses }
