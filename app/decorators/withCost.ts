// @ts-nocheck

export default function withCost(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value

  descriptor.value = async function (...args: any[]) {
    // Llamar a la función original
    const result = await originalMethod.apply(this, args)

    // Verificar si hay un objeto `cost` en el resultado
    if (result?.cost && typeof result.cost === 'object') {
      // Sumar todos los `totalCostInEur` dentro de las propiedades de `cost`
      result.cost.totalCostInEur = Object.values(result.cost).reduce((acc, value) => {
        if (Array.isArray(value)) {
          // Si es un array, sumar los `totalCostInEur` de sus objetos
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
          // Si es un objeto con `totalCostInEur`, sumarlo directamente
          return acc + value.totalCostInEur
        }
        return acc // Ignorar si no es ni un array ni un objeto válido
      }, 0)
    }

    return result
  }

  return descriptor
}
