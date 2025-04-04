import Photo from '#models/photo'

const IMAGE_WIDTH = 1500

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    categories: string[] = [],
    invert = false
  ) {
    await photo.load('detections')
    const targetBoxes = mergeOverlappingBoxes(
      categories.length > 0
        ? photo.detections.filter((d) => categories.includes(d.category))
        : photo.detections
    )

    if (!targetBoxes.length) return []

    let candidatePhotosQuery = Photo.query().where('id', '!=', photo.id)
    candidatePhotosQuery = candidatePhotosQuery.preload('detections', (query) => {
      if (categories.length > 0) {
        query.whereIn('category', categories)
      }
    })

    const candidatePhotos = await candidatePhotosQuery

    const candidateScores = candidatePhotos.map((candidate) => {
      const candidateBoxes = invert
        ? candidate.detections
            .filter((d) => categories.includes(d.category))
            .map((d) => ({
              ...d,
              x1: IMAGE_WIDTH - d.x2,
              x2: IMAGE_WIDTH - d.x1,
            }))
        : candidate.detections

      const score = computePhotoMatchScore(targetBoxes, candidateBoxes)
      return { photo: candidate, score }
    })

    candidateScores.sort((a, b) => b.score - a.score)

    return candidateScores.map((item) => ({
      ...item.photo.toJSON(),
      score: item.score,
    }))
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

function computePhotoMatchScore(targetBoxes, candidateBoxes, overlapRatioThreshold = 0.5) {
  if (!targetBoxes.length || !candidateBoxes.length) return 0
  let totalMatchScore = 0
  let matchedCount = 0

  targetBoxes.forEach((tBox) => {
    const areaT = boxArea(tBox)
    if (areaT <= 0) return

    const overlaps = candidateBoxes
      .map((cBox) => {
        const overlap = computeOverlapArea(tBox, cBox)
        return { cBox, overlap }
      })
      .filter((item) => item.overlap / areaT >= overlapRatioThreshold)

    if (!overlaps.length) return

    let sumWeightedBonus = 0
    let sumOverlap = 0
    overlaps.forEach(({ cBox, overlap }) => {
      const areaC = boxArea(cBox)
      const sizeSim = 1 - Math.abs(areaT - areaC) / Math.max(areaT, areaC)
      sumWeightedBonus += overlap * sizeSim
      sumOverlap += overlap
    })

    const matchBonus = sumOverlap > 0 ? sumWeightedBonus / sumOverlap : 0
    const areaMatchFraction = Math.min(1, sumOverlap / areaT)
    const targetBoxScore = areaMatchFraction * matchBonus

    totalMatchScore += targetBoxScore
    matchedCount++
  })

  if (matchedCount === 0) return 0

  const countBonus =
    1 -
    Math.abs(targetBoxes.length - candidateBoxes.length) /
      Math.max(targetBoxes.length, candidateBoxes.length)
  const averageMatchScore = totalMatchScore / matchedCount

  return 0.5 * averageMatchScore + 0.5 * countBonus
}

function mergeOverlappingBoxes(boxes, overlapThreshold = 0.7) {
  const merged = []

  const visited = new Array(boxes.length).fill(false)

  for (let i = 0; i < boxes.length; i++) {
    if (visited[i]) continue
    let current = boxes[i]
    let changed = true

    while (changed) {
      changed = false
      for (let j = 0; j < boxes.length; j++) {
        if (i === j || visited[j]) continue

        const b = boxes[j]
        const overlapArea = computeOverlapArea(current, b)
        const minArea = Math.min(boxArea(current), boxArea(b))

        if (overlapArea / minArea >= overlapThreshold) {
          // merge
          current = {
            x1: Math.min(current.x1, b.x1),
            y1: Math.min(current.y1, b.y1),
            x2: Math.max(current.x2, b.x2),
            y2: Math.max(current.y2, b.y2),
            category: current.category, // opcional: mantener categoría del primero
          }
          visited[j] = true
          changed = true
        }
      }
    }

    merged.push(current)
    visited[i] = true
  }

  return merged
}
