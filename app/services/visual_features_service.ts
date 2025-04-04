import Photo from '#models/photo'
import DetectionPhoto from '#models/detection_photo'

const IMAGE_WIDTH = 1500

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    categories: string[] = [],
    invert = false
  ) {
    await photo.load('detections')
    const referenceBoxes = this.filterDetections(photo.detections, categories)
    const allPhotos = await Photo.query().preload('detections')

    const candidateScores = allPhotos
      .filter((p) => p.id !== photo.id)
      .map((candidate) => {
        const candidateBoxes = this.filterDetections(candidate.detections, categories)
        const { overlapArea, refArea, candArea } = computeMutualOverlap(
          referenceBoxes,
          candidateBoxes
        )

        const baseScore = (overlapArea / refArea + overlapArea / candArea) / 2

        const boxCountBonus =
          1 -
          Math.abs(referenceBoxes.length - candidateBoxes.length) /
            Math.max(referenceBoxes.length, candidateBoxes.length)

        const finalScore = baseScore * 0.3 + boxCountBonus * 0.7

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

  private filterDetections(detections: DetectionPhoto[], categories: string[]) {
    return categories.length > 0
      ? detections.filter((d) => categories.includes(d.category))
      : detections
  }
}

// Helpers

function computeOverlapArea(boxA, boxB) {
  const overlapWidth = Math.max(0, Math.min(boxA.x2, boxB.x2) - Math.max(boxA.x1, boxB.x1))
  const overlapHeight = Math.max(0, Math.min(boxA.y2, boxB.y2) - Math.max(boxA.y1, boxB.y1))
  return overlapWidth * overlapHeight
}

function boxArea(box) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

function computeMutualOverlap(refBoxes, candBoxes) {
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
