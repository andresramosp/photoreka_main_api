import { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'

// Validator para el payload de solicitud de acceso
const requestAccessValidator = vine.compile(
  vine.object({
    email: vine.string().email(),
    // reason: vine.string().minLength(10).maxLength(500),
    portfolioLink: vine.string().optional(),
    hasLargeCollection: vine.boolean(),
  })
)

export default class LandingController {
  /**
   * Enviar email usando Mailjet (reutilizable, compatible con adjuntos)
   */
  async sendMailjetEmail({
    from,
    to,
    subject,
    body,
    attachments = [],
  }: {
    from: string
    to: string
    subject: string
    body: string
    attachments?: any[]
  }) {
    // Usar SendGrid
    const sgMailModule = await import('@sendgrid/mail')
    const sgMail = sgMailModule.default
    const apiKey = process.env.SENDGRID_API_KEY
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY no está definido en las variables de entorno')
    }
    sgMail.setApiKey(apiKey)

    // Adjuntos en formato SendGrid
    const sgAttachments = attachments.map((attachment) => ({
      content: attachment.content.toString('base64'),
      filename: attachment.filename,
      type: attachment.contentType,
      disposition: 'attachment',
    }))

    const msg = {
      to,
      from,
      subject,
      html: body,
      attachments: sgAttachments.length > 0 ? sgAttachments : undefined,
    }
    return sgMail.send(msg)
  }
  /**
   * Manejar solicitudes de acceso desde la landing page
   */
  async request({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(requestAccessValidator)

      // Crear el contenido del email
      const emailContent = `
        <h2>Nueva Solicitud de Acceso - Photoreka</h2>
        <p><strong>Email del usuario:</strong> ${payload.email}</p>
        <p><strong>Enlace del portafolio:</strong> ${payload.portfolioLink || 'No proporcionado'}</p>
        <p><strong>Tiene colección grande:</strong> ${payload.hasLargeCollection ? 'Sí' : 'No'}</p>
        <hr>
        <p><small>Solicitud recibida el ${new Date().toLocaleString('es-ES')}</small></p>
      `

      // Usar el método reutilizable para enviar el email
      await this.sendMailjetEmail({
        from: 'andreschennai@hotmail.com', //'request@photoreka.com',
        to: 'andreschennai@gmail.com',
        subject: `Nueva solicitud de acceso - ${payload.email}`,
        body: emailContent,
      })

      return response.status(200).json({
        message: 'Solicitud enviada correctamente. Te contactaremos pronto.',
        success: true,
      })
    } catch (error) {
      console.error('Error al procesar solicitud de acceso:', error)

      // Si es un error de validación
      if (error.messages) {
        return response.status(422).json({
          message: 'Datos de solicitud inválidos',
          errors: error.messages,
          success: false,
        })
      }

      // Error general
      return response.status(500).json({
        message: 'Error interno del servidor. Inténtalo más tarde.',
        success: false,
      })
    }
  }
}
