// @ts-nocheck

import nlp from 'compromise'

export default class NLPService {
  public getSustantives(sintagma: string): string[] | null {
    const words = sintagma.trim().split(/\s+/)
    if (words.length < 2) return null

    const doc = nlp(sintagma)
    // Extraemos las frases nominales
    const nounPhrases = doc.nouns().json()
    const mainNouns: string[] = []

    nounPhrases.forEach((np) => {
      if (np.terms && np.terms.length > 0) {
        // Buscamos el último término etiquetado como 'Noun'
        const headTerm = np.terms
          .slice()
          .reverse()
          .find((term) => term.tags.includes('Noun'))
        if (headTerm) {
          mainNouns.push(headTerm.text)
        }
      }
    })
    return mainNouns.length > 0 ? mainNouns : null
  }
}
