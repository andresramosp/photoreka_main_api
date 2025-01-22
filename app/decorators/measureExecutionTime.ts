export default function MeasureExecutionTime(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value

  descriptor.value = async function (...args: any[]) {
    const start = performance.now()
    const result = await originalMethod.apply(this, args)
    const end = performance.now()
    const executionTime = ((end - start) / 1000).toFixed(3)
    console.log(`Execution time [${propertyKey}]: ${executionTime} seconds`)
    return result
  }

  return descriptor
}
