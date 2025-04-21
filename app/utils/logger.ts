export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export class Logger {
  private static instances: Map<string, Logger> = new Map()
  private prefix: string
  private suffix: string | null
  private level: LogLevel

  private constructor(prefix: string, suffix?: string) {
    this.prefix = prefix
    this.suffix = suffix || null
    this.level = LogLevel.INFO
  }

  public static getInstance(prefix: string, suffix?: string): Logger {
    const key = suffix ? `${prefix}_${suffix}` : prefix
    if (!Logger.instances.has(key)) {
      Logger.instances.set(key, new Logger(prefix, suffix))
    }
    return Logger.instances.get(key)!
  }

  public setLevel(level: LogLevel): void {
    this.level = level
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level
  }

  private formatMessage(message: string): string {
    const prefix = `[${this.prefix}]`
    const suffix = this.suffix ? ` -> [${this.suffix}]` : ''
    return `${prefix}${suffix} ${message}`
  }

  public debug(message: string): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatMessage(message))
    }
  }

  public info(message: string): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatMessage(message))
    }
  }

  public warn(message: string): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(message))
    }
  }

  public error(message: string): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(message))
    }
  }
}

export default Logger
