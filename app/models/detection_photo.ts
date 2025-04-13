import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class DetectionPhoto extends BaseModel {
  public static table = 'detections_photos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare photoId: number

  @column()
  declare category: string

  @column({ columnName: 'x1' })
  declare x1: number

  @column({ columnName: 'y1' })
  declare y1: number

  @column({ columnName: 'x2' })
  declare x2: number

  @column({ columnName: 'y2' })
  declare y2: number

  public getBoxParams() {
    const cx = (this.x1 + this.x2) / 2
    const cy = (this.y1 + this.y2) / 2
    const w = this.x2 - this.x1
    const h = this.y2 - this.y1
    return { cx, cy, w, h }
  }

  public similarity(other: DetectionPhoto): number {
    const { cx: cxA, cy: cyA, w: wA, h: hA } = this.getBoxParams()
    const { cx: cxB, cy: cyB, w: wB, h: hB } = other.getBoxParams()

    const distCenter = Math.sqrt((cxA - cxB) ** 2 + (cyA - cyB) ** 2)
    const distSize = Math.sqrt((wA - wB) ** 2 + (hA - hB) ** 2)
    const diagA = Math.sqrt(wA ** 2 + hA ** 2)
    const diagB = Math.sqrt(wB ** 2 + hB ** 2)
    const diagMean = (diagA + diagB) / 2 || 1

    // Ajusta estos pesos según convenga
    const alpha = 0.5
    const beta = 0.5
    const distance = alpha * (distCenter / diagMean) + beta * (distSize / diagMean)

    // Mapeo distancia -> [0..1]: cajas idénticas => 1, muy distintas => ~0
    return Math.exp(-2 * distance)
  }

  // Devuelve el área de la caja
  public area(): number {
    const width = Math.max(0, this.x2 - this.x1)
    const height = Math.max(0, this.y2 - this.y1)
    return width * height
  }

  // Devuelve el área de solape entre "esta" caja y la caja "other"
  public overlapArea(other: DetectionPhoto): number {
    const overlapWidth = Math.max(0, Math.min(this.x2, other.x2) - Math.max(this.x1, other.x1))
    const overlapHeight = Math.max(0, Math.min(this.y2, other.y2) - Math.max(this.y1, other.y1))
    return overlapWidth * overlapHeight
  }
}
