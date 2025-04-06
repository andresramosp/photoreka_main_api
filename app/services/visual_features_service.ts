import Photo from '#models/photo'
import DetectionPhoto from '#models/detection_photo'

const IMAGE_WIDTH = 1500

const WEIGHTS = {
  distribution: 1,
  numberOfBoxes: 2,
}

const CATEGORY_GROUPS = [['animal', 'person'], ['prominent object']]

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    boxesIds: number[] = [],
    categoriesRef: string[] = [],
    categoriesCand: string[] = [],
    inverted = false
  ) {
    await photo.load('detections')

    const referenceBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
      photo.detections.filter((da) => !boxesIds.length || boxesIds.includes(da.id)),
      categoriesRef
    )

    const allPhotos = await Photo.query().preload('detections')

    const candidateScores = allPhotos
      .filter((p) => p.id !== photo.id)
      .map((candidate) => {
        let candidateBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
          candidate.detections,
          categoriesCand
        )
        if (inverted) {
          candidateBoxes = candidateBoxes.map(flipBoxHorizontally)
        }
        const finalScore = computeScore(referenceBoxes, candidateBoxes)

        return {
          photo: candidate,
          score: finalScore,
        }
      })

    candidateScores.sort((a, b) => b.score - a.score)

    return candidateScores.map((item) => ({
      ...item.photo.toJSON(),
      score: item.score,
    }))
  }

  private filterDetectionsByCategory(detections: DetectionPhoto[], categories: string[]) {
    return categories?.length > 0
      ? detections.filter((d) => categories.includes(d.category))
      : detections
  }
}

// Helpers

function isSameGroup(cat1: string, cat2: string) {
  return CATEGORY_GROUPS.some((group) => group.includes(cat1) && group.includes(cat2))
}

function computeOverlapArea(boxA: DetectionPhoto, boxB: DetectionPhoto) {
  const overlapWidth = Math.max(0, Math.min(boxA.x2, boxB.x2) - Math.max(boxA.x1, boxB.x1))
  const overlapHeight = Math.max(0, Math.min(boxA.y2, boxB.y2) - Math.max(boxA.y1, boxB.y1))
  return overlapWidth * overlapHeight
}

function boxArea(box: DetectionPhoto) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

function computeMutualOverlap(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
  let overlapArea = 0

  for (const ref of refBoxes) {
    for (const cand of candBoxes) {
      if (isSameGroup(ref.category, cand.category)) {
        overlapArea += computeOverlapArea(ref, cand)
      }
    }
  }

  const refArea = refBoxes
    .filter((ref) => candBoxes.some((c) => isSameGroup(ref.category, c.category)))
    .reduce((acc, box) => acc + boxArea(box), 0)

  const candArea = candBoxes
    .filter((c) => refBoxes.some((ref) => isSameGroup(ref.category, c.category)))
    .reduce((acc, box) => acc + boxArea(box), 0)

  return { overlapArea, refArea, candArea }
}

function computeBoxCountBonus(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
  if (refBoxes.length > 0 && candBoxes.length > 0) {
    return (
      1 - Math.abs(refBoxes.length - candBoxes.length) / Math.max(refBoxes.length, candBoxes.length)
    )
  }
  return 0
}

function computeScore(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
  const { overlapArea, refArea, candArea } = computeMutualOverlap(refBoxes, candBoxes)

  const safeRefArea = refArea > 0 ? refArea : 1
  const safeCandArea = candArea > 0 ? candArea : 1

  const baseScore = (overlapArea / safeRefArea + overlapArea / safeCandArea) / 2
  const boxCountBonus = computeBoxCountBonus(refBoxes, candBoxes)

  return baseScore * WEIGHTS.distribution + boxCountBonus * WEIGHTS.numberOfBoxes
}

function flipBoxHorizontally(box: DetectionPhoto) {
  return {
    ...box,
    x1: IMAGE_WIDTH - box.x2,
    x2: IMAGE_WIDTH - box.x1,
    y1: box.y1,
    y2: box.y2,
  }
}
