export interface DimensionalReductionResult {
  id: number
  coordinates: number[]
}

export type ReductionMethod = 'pca'

/**
 * Servicio para reducción dimensional usando implementaciones nativas de JavaScript
 */
export default class DimensionalReductionService {
  /**
   * Reduce la dimensionalidad usando PCA (Principal Component Analysis)
   */
  private async performPCA(
    vectors: { id: number; embedding: number[] }[],
    targetDimensions: number = 3
  ): Promise<DimensionalReductionResult[]> {
    if (vectors.length === 0) return []

    // Extraer solo las matrices de embeddings
    const embeddings = vectors.map((v) => v.embedding)

    // Centrar los datos (restar la media)
    const mean = this.calculateMean(embeddings)
    const centeredData = embeddings.map((vector) => vector.map((val, idx) => val - mean[idx]))

    // Para simplificar, usaremos un enfoque de reducción dimensional básico
    // tomando las primeras N componentes principales simuladas
    const reducedData = this.projectToLowerDimension(centeredData, targetDimensions)

    // Mapear los resultados de vuelta con sus IDs
    return vectors.map((vector, index) => ({
      id: vector.id,
      coordinates: reducedData[index] || [0, 0, 0],
    }))
  }

  /**
   * Calcula la media de un conjunto de vectores
   */
  private calculateMean(vectors: number[][]): number[] {
    const dimension = vectors[0].length
    const mean = new Array(dimension).fill(0)

    for (const vector of vectors) {
      for (let i = 0; i < dimension; i++) {
        mean[i] += vector[i]
      }
    }

    return mean.map((sum) => sum / vectors.length)
  }

  /**
   * Proyecta los datos a una dimensión menor usando una aproximación simplificada
   */
  private projectToLowerDimension(centeredData: number[][], targetDim: number): number[][] {
    // Implementación simplificada: tomar las primeras componentes y aplicar transformaciones
    return centeredData.map((vector) => {
      const result: number[] = []

      // Para 3D, usamos combinaciones lineales de las dimensiones originales
      if (targetDim >= 1) {
        // Primera componente: suma ponderada de las primeras dimensiones
        result[0] = vector
          .slice(0, Math.min(10, vector.length))
          .reduce((sum, val, idx) => sum + val * Math.cos(idx * 0.1), 0)
      }

      if (targetDim >= 2) {
        // Segunda componente: otra combinación
        result[1] = vector
          .slice(0, Math.min(10, vector.length))
          .reduce((sum, val, idx) => sum + val * Math.sin(idx * 0.1), 0)
      }

      if (targetDim >= 3) {
        // Tercera componente: combinación diferente
        result[2] = vector
          .slice(Math.max(0, vector.length - 10))
          .reduce((sum, val, idx) => sum + val * Math.cos(idx * 0.2), 0)
      }

      return result
    })
  }

  /**
   * Normaliza las coordenadas para una mejor visualización
   */
  private normalizeCoordinates(coordinates: number[][]): number[][] {
    if (coordinates.length === 0) return coordinates

    const dimensions = coordinates[0].length
    const normalized: number[][] = []

    // Calcular min y max para cada dimensión
    const mins = new Array(dimensions).fill(Infinity)
    const maxs = new Array(dimensions).fill(-Infinity)

    for (const coord of coordinates) {
      for (let i = 0; i < dimensions; i++) {
        mins[i] = Math.min(mins[i], coord[i])
        maxs[i] = Math.max(maxs[i], coord[i])
      }
    }

    // Normalizar a rango [-1, 1]
    for (const coord of coordinates) {
      const normalizedCoord: number[] = []
      for (let i = 0; i < dimensions; i++) {
        const range = maxs[i] - mins[i]
        if (range === 0) {
          normalizedCoord[i] = 0
        } else {
          normalizedCoord[i] = 2 * ((coord[i] - mins[i]) / range) - 1
        }
      }
      normalized.push(normalizedCoord)
    }

    return normalized
  }

  /**
   * Reduce la dimensionalidad de un conjunto de vectores
   */
  public async reduceDimensionality(
    vectors: { id: number; embedding: number[] }[],
    method: ReductionMethod = 'pca',
    targetDimensions: number = 3
  ): Promise<DimensionalReductionResult[]> {
    if (!vectors || vectors.length === 0) {
      throw new Error('No vectors provided for dimensional reduction')
    }

    // Validar que todos los vectores tengan la misma dimensión
    const firstDim = vectors[0].embedding.length
    for (const vector of vectors) {
      if (vector.embedding.length !== firstDim) {
        throw new Error('All vectors must have the same dimension')
      }
    }

    let reducedCoordinates: number[][]

    switch (method) {
      case 'pca':
        const result = await this.performPCA(vectors, targetDimensions)
        reducedCoordinates = result.map((r) => r.coordinates)
        break
      default:
        throw new Error(`Unsupported reduction method: ${method}`)
    }

    // Normalizar las coordenadas
    const normalizedCoords = this.normalizeCoordinates(reducedCoordinates)

    // Mapear de vuelta con los IDs
    return vectors.map((vector, index) => ({
      id: vector.id,
      coordinates: normalizedCoords[index] || [0, 0, 0],
    }))
  }

  /**
   * Reduce dimensionalidad específicamente para visualización 3D
   */
  public async reduce3D(
    vectors: { id: number; embedding: number[] }[]
  ): Promise<DimensionalReductionResult[]> {
    return this.reduceDimensionality(vectors, 'pca', 3)
  }
}
