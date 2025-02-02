import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { google } = require('googleapis')

export class GoogleAuthService {
  private static oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  /**
   * Obtiene la URL de autenticación de Google Photos
   */
  public static getAuthUrl(): string {
    const scopes = ['https://www.googleapis.com/auth/photoslibrary.readonly']
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    })
  }

  /**
   * Intercambia el código de autorización por un access token
   */
  public static async getAccessToken(code: string): Promise<string> {
    const { tokens } = await this.oauth2Client.getToken(code)
    this.oauth2Client.setCredentials(tokens)
    return tokens.access_token as string
  }
}
