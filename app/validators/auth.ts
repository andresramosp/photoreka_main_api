import vine from '@vinejs/vine'

/**
 * Validates the user registration payload
 */
export const createAuthValidator = vine.compile(
  vine.object({
    name: vine.string().minLength(2).maxLength(50),
    email: vine.string().email().normalizeEmail(),
    password: vine.string().minLength(8).maxLength(100),
    authCode: vine.string().minLength(10).maxLength(40).optional(),
  })
)

/**
 * Validates the user login payload
 */
export const createLoginValidator = vine.compile(
  vine.object({
    email: vine.string().email().normalizeEmail(),
    password: vine.string().minLength(1),
  })
)

/**
 * Validates the password change payload
 */
export const changePasswordValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1),
    newPassword: vine.string().minLength(8).maxLength(100),
  })
)

/**
 * Validates the profile update payload
 */
export const updateProfileValidator = vine.compile(
  vine.object({
    name: vine.string().minLength(2).maxLength(50).optional(),
    email: vine.string().email().normalizeEmail().optional(),
  })
)
