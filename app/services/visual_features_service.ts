import Photo from '#models/photo'
import DetectionPhoto from '#models/detection_photo'

const IMAGE_WIDTH = 1500

const WEIGHTS = {
  distribution: 0.1,
  numberOfBoxes: 0.9,
}

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    boxesIds: number[] = [],
    categories: string[] = [],
    inverted = false
  ) {
    await photo.load('detections')
    const referenceBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
      photo.detectionAreas.filter((da) => !boxesIds.length || boxesIds.includes(da.id)),
      categories
    )
    const allPhotos = await Photo.query().preload('detections')

    const candidateScores = allPhotos
      .filter((p) => p.id !== photo.id)
      .map((candidate) => {
        let candidateBoxes: DetectionPhoto[] = this.filterDetectionsByCategory(
          candidate.detectionAreas,
          ['animal', 'person']
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

function computeOverlapArea(boxA: DetectionPhoto, boxB: DetectionPhoto) {
  const overlapWidth = Math.max(0, Math.min(boxA.x2, boxB.x2) - Math.max(boxA.x1, boxB.x1))
  const overlapHeight = Math.max(0, Math.min(boxA.y2, boxB.y2) - Math.max(boxA.y1, boxB.y1))
  return overlapWidth * overlapHeight
}

function boxArea(box: DetectionPhoto) {
  let result = Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
  if (Number.isNaN(result)) {
    console.log()
  }
  return result
}

function computeMutualOverlap(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
  let overlapArea = 0
  for (const ref of refBoxes) {
    for (const cand of candBoxes) {
      overlapArea += computeOverlapArea(ref, cand)
    }
  }

  const refArea = refBoxes.reduce((acc, box) => acc + boxArea(box), 0)
  const candArea = candBoxes.reduce((acc, box) => acc + boxArea(box), 0)

  return { overlapArea, refArea, candArea }
}

function computeScore(refBoxes: DetectionPhoto[], candBoxes: DetectionPhoto[]) {
  const { overlapArea, refArea, candArea } = computeMutualOverlap(refBoxes, candBoxes)

  const safeRefArea = refArea > 0 ? refArea : 1
  const safeCandArea = candArea > 0 ? candArea : 1

  const baseScore = (overlapArea / safeRefArea + overlapArea / safeCandArea) / 2

  const boxCountBonus =
    refBoxes.length && candBoxes.length
      ? 1 -
        Math.abs(refBoxes.length - candBoxes.length) / Math.max(refBoxes.length, candBoxes.length)
      : 0

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
