/** Selection-helper NDJSON and the drag threshold shared with the Darwin monitor. */

export const MIN_DRAG_PX = 8

export function draggedFarEnough(dx, dy) {
  return Math.hypot(dx, dy) >= MIN_DRAG_PX
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseBounds(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)
    || !isFiniteNumber(record.width) || !isFiniteNumber(record.height)) {
    return undefined
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}

/** Parse one NDJSON line from the Darwin selection monitor. */
export function parseSelectionHelperLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let value
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  switch (value.type) {
    case 'ready':
      return { type: 'ready' }
    case 'untrusted':
      return { type: 'untrusted' }
    case 'key':
      return { type: 'key' }
    case 'dismiss':
      return { type: 'dismiss' }
    case 'mouse-down':
    case 'mouse-up':
      if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined
      return { type: value.type, x: value.x, y: value.y }
    case 'selection': {
      if (typeof value.text !== 'string' || value.text.trim() === '') return undefined
      const bounds = parseBounds(value.bounds)
      return {
        type: 'selection',
        text: value.text,
        ...bounds === undefined ? {} : { bounds },
        ...isFiniteNumber(value.x) ? { x: value.x } : {},
        ...isFiniteNumber(value.y) ? { y: value.y } : {},
        ...isFiniteNumber(value.pid) ? { pid: value.pid } : {},
        ...typeof value.bundle === 'string' ? { bundle: value.bundle } : {},
      }
    }
    default:
      return undefined
  }
}
