import Photo from '#models/photo'
import DetectionPhoto from '#models/detection_photo'

const WEIGHTS = (coverageRatio: number = 0) => {
  const locationRatio = 1 - coverageRatio
  return {
    global: 0.7 + locationRatio,
    individual: 1,
    numBoxes: 0.5 + locationRatio,
  }
}

const MAX_DIFF_BOXES = 0
const CATEGORY_GROUPS = [
  ['animal', 'person'],
  ['prominent object', 'architectural feature'],
]
const CROSS_GROUP_PENALTY = 0 // unificarlo
const IMAGE_WIDTH = 1500

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    boxesIds: number[] = [],
    categoriesRef: string[] = [],
    categoriesCand: string[] = [],
    inverted = false
  ) {
    await photo.load('detections')

    let referenceBoxes: DetectionPhoto[]
    let originalRefBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
      photo.detectionAreas.filter((da) => !boxesIds.length || boxesIds.includes(da.id)),
      categoriesRef
    )

    let coverage = this.computeCoverageArea(originalRefBoxes)

    const allPhotos = await Photo.query().preload('detections')

    const candidateScores = allPhotos
      .filter((p) => p.id !== photo.id)
      .map((candidate) => {
        let candidateBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
          candidate.detectionAreas,
          categoriesCand
        )

        referenceBoxes = inverted
          ? originalRefBoxes.map((box) => this.flipBoxHorizontally(box))
          : originalRefBoxes

        // Filtro: descartar (o puntuar 0) si la diferencia de cajas supera MAX_DIFF_BOXES
        if (Math.abs(referenceBoxes.length - candidateBoxes.length) > MAX_DIFF_BOXES) {
          return {
            photo: candidate,
            score: 0,
          }
        }

        return {
          photo: candidate,
          score: this.computeScore(referenceBoxes, candidateBoxes, coverage),
        }
      })

    candidateScores.sort((a, b) => b.score - a.score)

    return candidateScores
      .map((item) => ({
        ...item.photo.toJSON(),
        score: item.score,
      }))
      .filter((item) => item.score > 0)
  }

  // --------------------------------------------------------------------------
  // Métodos privados
  // --------------------------------------------------------------------------

  private filterDetectionsByCategory(detections: DetectionPhoto[], categories: string[]) {
    return categories?.length
      ? detections.filter((d) => categories.includes(d.category))
      : detections
  }

  private computeScore(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[], coverage: number) {
    if (!this.hasAnyCompatibleGroup(refBoxes, candBoxes)) {
      return 0
    }

    // const individual = this.matchScoreIndividual(refBoxes, candBoxes)
    const global = this.matchScoreGlobal(refBoxes, candBoxes)
    // const numBoxesSim = this.matchScoreNumBoxes(refBoxes, candBoxes)

    const weightedSum =
      // WEIGHTS(coverage).individual * individual +
      WEIGHTS(coverage).global * global
    // WEIGHTS(coverage).numBoxes * numBoxesSim

    const totalWeights =
      WEIGHTS(coverage).individual + WEIGHTS(coverage).global + WEIGHTS(coverage).numBoxes

    return totalWeights > 0 ? weightedSum / totalWeights : 0
  }

  private hasAnyCompatibleGroup(a: DetectionPhoto[], b: DetectionPhoto[]) {
    return a.some((boxA) => b.some((boxB) => this.isSameGroup(boxA.category, boxB.category)))
  }

  private matchScoreIndividual(
    detectionsRef: DetectionPhoto[],
    detectionsCand: DetectionPhoto[]
  ): number {
    let totalScore = 0
    let matches = 0
    const usedCand = new Set<number>()

    for (const detRef of detectionsRef) {
      let bestScore = 0
      let bestIndex = -1

      for (let i = 0; i < detectionsCand.length; i++) {
        if (usedCand.has(i)) continue

        const detCand = detectionsCand[i]
        const sim = detRef.similarity(detCand)

        let adjustedSim = sim
        // if (!this.isSameGroup(detRef.category, detCand.category)) {
        //   adjustedSim *= CROSS_GROUP_PENALTY
        // }
        if (!this.isSameGroup(detRef.category, detCand.category)) continue

        if (adjustedSim > bestScore) {
          bestScore = adjustedSim
          bestIndex = i
        }
      }

      if (bestIndex !== -1) {
        usedCand.add(bestIndex)
        totalScore += bestScore
        matches++
      }
    }

    return detectionsRef.length > 0 ? totalScore / detectionsRef.length : 0
  }

  private matchScoreGlobal(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]): number {
    const { overlapArea, refArea, candArea } = this.computeMutualOverlap(refBoxes, candBoxes)
    const union = refArea + candArea - overlapArea
    if (union <= 0) {
      return 0
    }
    return overlapArea / union // IoU global
  }

  private matchScoreNumBoxes(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]): number {
    const refCount = refBoxes.length
    const candCount = candBoxes.length
    if (refCount === 0 && candCount === 0) {
      return 1 // Ambas sin detecciones => similitud 1
    }
    const maxVal = Math.max(refCount, candCount)
    if (maxVal === 0) {
      return 0
    }
    // p.ej. 1 - (|diferencia| / max). Si difieren mucho, se acerca a 0
    const diffRatio = Math.abs(refCount - candCount) / maxVal
    const score = 1 - diffRatio
    return score < 0 ? 0 : score
  }

  private computeMutualOverlap(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
    let overlapArea = 0

    for (const ref of refBoxes) {
      for (const cand of candBoxes) {
        if (this.isSameGroup(ref.category, cand.category)) {
          overlapArea += ref.overlapArea(cand)
        }
      }
    }

    const refArea = refBoxes
      .filter((ref) => candBoxes.some((c) => this.isSameGroup(ref.category, c.category)))
      .reduce((acc, box) => acc + box.area(), 0)

    const candArea = candBoxes
      .filter((cand) => refBoxes.some((r) => this.isSameGroup(r.category, cand.category)))
      .reduce((acc, box) => acc + box.area(), 0)

    return { overlapArea, refArea, candArea }
  }

  private computeCoverageArea(refBoxes: DetectionPhoto[]): number {
    if (!refBoxes.length) return 0

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity

    for (const box of refBoxes) {
      if (box.x1 < minX) minX = box.x1
      if (box.y1 < minY) minY = box.y1
      if (box.x2 > maxX) maxX = box.x2
      if (box.y2 > maxY) maxY = box.y2
    }

    const unionWidth = Math.max(0, maxX - minX)
    const unionHeight = Math.max(0, maxY - minY)
    const unionArea = unionWidth * unionHeight

    const imageArea = (IMAGE_WIDTH * IMAGE_WIDTH) / 1.5

    const coverage = unionArea / imageArea
    return Math.max(0, Math.min(1, coverage)) // normalizado entre 0 y 1
  }

  private isSameGroup(cat1: string, cat2: string) {
    return CATEGORY_GROUPS.some((group) => group.includes(cat1) && group.includes(cat2))
  }

  private flipBoxHorizontally(box: DetectionPhoto): DetectionPhoto {
    const flipped = new DetectionPhoto()

    flipped.x1 = IMAGE_WIDTH - box.x2
    flipped.x2 = IMAGE_WIDTH - box.x1
    flipped.y1 = box.y1
    flipped.y2 = box.y2
    flipped.category = box.category
    // Copia otros atributos necesarios aquí

    return flipped
  }
}
