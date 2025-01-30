// @ts-nocheck

export default function withCostWS(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value

  descriptor.value = async function* (...args: any[]) {
    let totalCostInEur = 0

    for await (const result of originalMethod.apply(this, args)) {
      if (result?.data?.cost && typeof result.data.cost === 'object') {
        // Sumar los costos parciales
        totalCostInEur = Object.values(result.data.cost).reduce((acc, value) => {
          if (Array.isArray(value)) {
            return (
              acc +
              value.reduce((subAcc, subValue) => {
                if (subValue && typeof subValue === 'object' && 'totalCostInEur' in subValue) {
                  return subAcc + subValue.totalCostInEur
                }
                return subAcc
              }, 0)
            )
          } else if (value && typeof value === 'object' && 'totalCostInEur' in value) {
            return acc + value.totalCostInEur
          }
          return acc
        }, totalCostInEur)

        // Actualizar el objeto `cost` con el total acumulado
        result.data.cost.totalCostInEur = totalCostInEur
      }

      yield result
    }
  }

  return descriptor
}
