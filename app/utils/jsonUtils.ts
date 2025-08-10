export const parseJSONSafe = (input: string, keyMapping: any) => {
  let cleaned = input.trim()
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.slice(3, -3).trim()
  }

  // Reemplazo de claves en toda la cadena (no recursivo)
  Object.keys(keyMapping).forEach((key) => {
    const newKey = keyMapping[key]
    const escapedKey = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const regex = new RegExp(`"${escapedKey}"\\s*:`, 'g')
    cleaned = cleaned.replace(regex, `"${newKey}":`)
  })

  console.log('JSON modificado:', cleaned)

  try {
    return JSON.parse(cleaned)
  } catch (error) {
    console.error('Error al parsear JSON:', error)
    return null
  }
}

// Robust parser that tolerates:
// - Markdown fences ```json ... ```
// - Single quoted keys ('key':) and simple single-quoted string values
// - Trailing commas before } or ]
// - Returns {} if it cannot parse
export const robustJsonParse = (raw: any): any => {
  if (raw == null) return {}
  if (typeof raw !== 'string') return raw

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  const stripFences = (str: string) =>
    (str || '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim()

  let cleaned = stripFences(raw)
  let parsed: any = tryParse(cleaned)

  if (!parsed) {
    let minimallyFixed = cleaned
      .replace(/'([A-Za-z0-9_\-]+)'\s*:/g, '"$1":')
      .replace(/:\s*'([^'"\\]*)'/g, ': "$1"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/,,+/g, ',')
      .trim()
    parsed = tryParse(minimallyFixed)

    if (!parsed) {
      const objMatch = minimallyFixed.match(/\{[\s\S]*\}/)
      const arrMatch = minimallyFixed.match(/\[[\s\S]*\]/)
      let fragment: string | null = null
      if (arrMatch) fragment = arrMatch[0]
      else if (objMatch) fragment = objMatch[0]
      if (fragment) {
        const fragFixed = fragment
          .replace(/'([A-Za-z0-9_\-]+)'\s*:/g, '"$1":')
          .replace(/:\s*'([^'"\\]*)'/g, ': "$1"')
          .replace(/,\s*([}\]])/g, '$1')
        parsed = tryParse(fragFixed)
      }
    }
  }

  if (!parsed) {
    console.warn('[robustJsonParse] Failed to parse snippet (truncated):', raw.slice(0, 400))
    return {}
  }
  return parsed
}
