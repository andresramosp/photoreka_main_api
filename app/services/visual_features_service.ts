import Photo from '#models/photo'
import DetectionPhoto from '#models/detection_photo'

const WEIGHTS = {
  global: 1,
  individual: 2,
}

const MAX_DIFF_BOXES = 0

export default class VisualFeaturesService {
  // Ajusta según tu caso
  private static readonly IMAGE_WIDTH = 1500

  private static readonly CATEGORY_GROUPS = [['animal', 'person', 'prominent object']]

  public async findSimilarPhotosByDetections(
    photo: Photo,
    boxesIds: number[] = [],
    categoriesRef: string[] = [],
    categoriesCand: string[] = [],
    inverted = false
  ) {
    await photo.load('detections')

    const referenceBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
      photo.detectionAreas.filter((da) => !boxesIds.length || boxesIds.includes(da.id)),
      categoriesRef
    )

    const allPhotos = await Photo.query().preload('detections')

    const candidateScores = allPhotos
      .filter((p) => p.id !== photo.id)
      .map((candidate) => {
        let candidateBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
          candidate.detectionAreas,
          categoriesCand
        )

        if (inverted) {
          candidateBoxes = candidateBoxes.map((box) => this.flipBoxHorizontally(box))
        }

        if (Math.abs(referenceBoxes.length - candidateBoxes.length) > MAX_DIFF_BOXES) {
          return {
            photo: candidate,
            score: 0,
          }
        }

        return {
          photo: candidate,
          score: this.computeScore(referenceBoxes, candidateBoxes),
        }
      })

    candidateScores.sort((a, b) => b.score - a.score)

    return candidateScores.map((item) => ({
      ...item.photo.toJSON(),
      score: item.score,
    }))
  }

  // ------------------------------------------------------------------------------
  // Métodos privados
  // ------------------------------------------------------------------------------

  private filterDetectionsByCategory(detections: DetectionPhoto[], categories: string[]) {
    return categories?.length
      ? detections.filter((d) => categories.includes(d.category))
      : detections
  }

  private computeScore(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
    const individual = this.matchScoreIndividual(refBoxes, candBoxes)
    const global = this.matchScoreGlobal(refBoxes, candBoxes)

    const weightedSum = WEIGHTS.individual * individual + WEIGHTS.global * global

    const totalWeights = WEIGHTS.individual + WEIGHTS.global

    return totalWeights > 0 ? weightedSum / totalWeights : 0
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
        if (!this.isSameGroup(detRef.category, detCand.category)) continue

        const sim = detRef.similarity(detCand)
        if (sim > bestScore) {
          bestScore = sim
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

  private isSameGroup(cat1: string, cat2: string) {
    return VisualFeaturesService.CATEGORY_GROUPS.some(
      (group) => group.includes(cat1) && group.includes(cat2)
    )
  }

  private flipBoxHorizontally(box: DetectionPhoto) {
    return {
      ...box,
      x1: VisualFeaturesService.IMAGE_WIDTH - box.x2,
      x2: VisualFeaturesService.IMAGE_WIDTH - box.x1,
      y1: box.y1,
      y2: box.y2,
    }
  }
}
