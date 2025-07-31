import { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

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
    // Usar las mismas keys proporcionadas
    const mailjet = require('node-mailjet').apiConnect(
      '47486c2ca0d07891a61203abd9207956',
      '1b3daf18222e56372a156a4a24f25d9a'
    )

    const mailAttachments = attachments.map((attachment) => {
      return {
        ContentType: attachment.contentType,
        Filename: attachment.filename,
        Base64Content: attachment.content.toString('base64'),
      }
    })

    return mailjet.post('send', { version: 'v3.1' }).request({
      Messages: [
        {
          From: {
            Email: from,
            Name: '',
          },
          To: [
            {
              Email: to,
              Name: '',
            },
          ],
          Subject: subject,
          HTMLPart: body,
          Attachments: mailAttachments,
        },
      ],
    })
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
        from: 'andreschennai@gmail.com', //'request@photoreka.com',
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
