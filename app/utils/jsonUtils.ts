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
