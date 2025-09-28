# Servicio de Reducción Dimensional - Guía de Uso Actualizada

## Cambios Realizados

### ✅ Problemas Corregidos

1. **Normalización Final**: Reemplazada normalización rígida [-1,1] por z-score que preserva la estructura de clusters
2. **PCA Mejorado**: Mayor precisión de convergencia, deflación robusta con verificación de simetría
3. **t-SNE Optimizado**: Inicialización con PCA, momentum, early exaggeration, 1000 iteraciones
4. **Combinación de Embeddings**: Métodos para combinar múltiples tipos de embeddings con pesos adaptativos
5. **Validación y Diagnóstico**: Detección automática de problemas de varianza y recomendaciones

### 🔄 API Actualizada

#### Métodos Principales

```typescript
// Reducción básica (con z-score normalización)
service.reduceDimensionality(vectors, 'tsne', 3)

// Reducción con validación automática
service.reduceDimensionalityWithValidation(vectors, 'tsne', 3)

// Combinación de múltiples embeddings
service.reduceDimensionalityWithCombinedEmbeddings(
  vectorsWithMultipleEmbeddings,
  { cultural: 0.4, narrative: 0.6 },
  'tsne',
  3
)
```

#### Métodos Especializados

```typescript
// Para embeddings CLIP (soporta combinación)
service.reduce3DForCLIP(vectors)

// Para embeddings de texto (soporta combinación)
service.reduce3DForText(vectors)

// Para embeddings culturales combinados
service.reduce3DForCultural(vectors, 'narrative', 0.5)
```

## Casos de Uso Recomendados

### 1. Embeddings Culturales (Baja Varianza)

**Problema**: Los embeddings culturales tienen poca varianza → proyección concentrada
**Solución**: Combinar con otros embeddings

```typescript
// Opción A: Combinar cultural + narrativa
const combinedVectors = photos.map((photo) => ({
  id: photo.id,
  embeddings: {
    cultural: photo.culturalEmbedding,
    narrative: photo.narrativeEmbedding,
  },
}))

const result = await service.reduce3DForCultural(
  combinedVectors,
  'narrative', // Partner preferido
  0.4 // Peso cultural (40%)
)

// Opción B: Combinar cultural + CLIP
const result2 = await service.reduceDimensionalityWithCombinedEmbeddings(
  combinedVectors,
  { cultural: 0.3, clip: 0.7 }, // Mayor peso a CLIP
  'tsne',
  3
)
```

### 2. Validación Previa y Diagnóstico

```typescript
// Validar calidad de embeddings antes de procesar
const { result, diagnostics } = await service.reduceDimensionalityWithValidation(vectors, 'tsne', 3)

console.log('Issues found:', diagnostics.issues)
console.log('Recommendations:', diagnostics.recommendations)
console.log('Mean variance:', diagnostics.statistics.meanVariance)

if (diagnostics.statistics.hasLowVarianceComponents) {
  console.log('⚠️ Low variance detected - consider combining embeddings')
}
```

### 3. Embeddings CLIP con Alta Varianza

```typescript
// Para embeddings CLIP puros (ya tienen buena varianza)
const clipVectors = photos.map((photo) => ({
  id: photo.id,
  embedding: photo.clipEmbedding,
}))

const result = await service.reduce3DForCLIP(clipVectors)
```

## Interpretación de Resultados

### ❌ Interpretación Incorrecta

```
"El eje X representa el aspecto cultural"
"Valores altos en Y = más artístico"
```

### ✅ Interpretación Correcta

```
- Puntos cercanos = fotos similares
- Clusters = grupos de fotos con características similares
- Distancia relativa = medida de similitud
- Dispersión general = varianza en el dataset
```

## Parámetros de Configuración

### t-SNE Mejorado

- **Iteraciones**: 1000 (vs 200 anterior)
- **Early Exaggeration**: 250 iteraciones con factor 4.0
- **Momentum**: 0.5 → 0.8 gradualmente
- **Learning Rate**: Adaptativo (500 → 200 → 100)
- **Inicialización**: PCA en lugar de aleatoria

### PCA Mejorado

- **Tolerancia**: 1e-8 (vs 1e-6 anterior)
- **Iteraciones**: 1000 (vs 100 anterior)
- **Deflación**: Con verificación de simetría
- **Convergencia**: Eigenvalue + eigenvector change

### Normalización

- **Anterior**: Min-max a [-1,1] → ❌ Aplasta clusters
- **Nueva**: Z-score (μ=0, σ=1) → ✅ Preserva estructura

## Troubleshooting

### Problema: "Puntos muy concentrados"

- **Causa**: Baja varianza en embeddings
- **Solución**: Combinar con otros tipos de embeddings
- **Método**: `service.combineCulturalWithOtherEmbeddings()`

### Problema: "Nube esférica sin estructura"

- **Causa**: Normalización inadecuada, pocas iteraciones
- **Solución**: Usar nueva implementación con z-score y más iteraciones
- **Verificación**: `diagnostics.statistics.hasLowVarianceComponents`

### Problema: "Clusters no se separan"

- **Causa**: Embeddings demasiado similares o dimensiones dominantes
- **Solución**: Validar con `validateAndDiagnoseEmbeddings()`
- **Alternativa**: Probar PCA en lugar de t-SNE

## Ejemplo Completo

```typescript
const service = new DimensionalReductionService()

// Caso: Embeddings culturales + narrativos
const photos = [
  {
    id: 1,
    culturalEmbedding: [0.1, 0.15, 0.12, ...], // Baja varianza
    narrativeEmbedding: [0.8, -0.3, 0.6, ...] // Alta varianza
  },
  // ... más fotos
]

// 1. Preparar datos
const combinedVectors = photos.map(photo => ({
  id: photo.id,
  embeddings: {
    cultural: photo.culturalEmbedding,
    narrative: photo.narrativeEmbedding
  }
}))

// 2. Validar calidad
const diagnostics = service.validateAndDiagnoseEmbeddings(
  photos.map(p => ({ id: p.id, embedding: p.culturalEmbedding }))
)

if (diagnostics.statistics.hasLowVarianceComponents) {
  console.log('⚠️ Using combined embeddings due to low cultural variance')

  // 3. Reducir con combinación optimizada
  const result = await service.reduce3DForCultural(
    combinedVectors,
    'narrative', // Partner que aporta varianza
    0.3 // Peso menor para cultural por su baja varianza
  )
} else {
  // 4. Usar embeddings culturales solos si tienen suficiente varianza
  const result = await service.reduceDimensionality(
    photos.map(p => ({ id: p.id, embedding: p.culturalEmbedding })),
    'tsne',
    3
  )
}

// 5. Usar coordenadas directamente en ThreeJS
result.forEach(item => {
  const [x, y, z] = item.coordinates
  scene.add(new THREE.Mesh(
    geometry,
    material.clone()
  ).position.set(x, y, z))
})
```

## Próximos Pasos

1. **Testear** las proyecciones con PCA primero para validar dispersión
2. **Experimentar** con diferentes combinaciones de pesos
3. **Usar** el diagnóstico para optimizar parámetros por dataset
4. **Evitar** normalizaciones adicionales en ThreeJS - usar coordenadas directamente
