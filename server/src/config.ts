// ============================================================================
// Runtime configuration, read once from the environment and validated.
// A missing or malformed value fails at boot with a message naming it, rather
// than surfacing later as a cryptic runtime error on the factory floor.
// ============================================================================

import { z } from 'zod'

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())))

const durationSeconds = z
  .string()
  .regex(/^\d+(s|m|h|d)?$/, 'Expected a duration such as 15m, 12h or 900')
  .transform((v) => {
    const m = /^(\d+)(s|m|h|d)?$/.exec(v)!
    const n = Number(m[1])
    switch (m[2]) {
      case 'm':
        return n * 60
      case 'h':
        return n * 3600
      case 'd':
        return n * 86400
      default:
        return n
    }
  })

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Max pooled connections. Azure Flexible Server B1ms allows ~50; leave headroom. */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: durationSeconds.default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    IMAGE_STORAGE_DRIVER: z.enum(['local', 'azure-blob']).default('local'),
    IMAGE_LOCAL_DIR: z.string().default('data/images'),
    AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
    AZURE_STORAGE_CONTAINER: z.string().default('qc-images'),
    AUTH_ALLOW_SELF_REGISTRATION: bool.default(true),
    RUN_MIGRATIONS_ON_START: bool.default(true),
    SEED_DEMO_DATA: bool.default(false),
    TRUST_PROXY: bool.default(false),
    /** IANA zone the factory runs on. Shifts are derived in this zone (§8.1). */
    FACTORY_TIMEZONE: z.string().default('Africa/Cairo').refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz })
          return true
        } catch {
          return false
        }
      },
      { message: 'Not a valid IANA time zone (e.g. Africa/Cairo)' },
    ),
    /** Directory holding the built client; served in production. */
    STATIC_DIR: z.string().default('public'),
    /** Upper bound on one uploaded photo after on-device compression. */
    MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
    MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
    /**
     * §20 — optional. The key is normally set by an administrator in the app
     * (Administration → AI assistant); one set here wins over it. Absent, the
     * assistant is simply off until a key is set — never a boot error.
     */
    ANTHROPIC_API_KEY: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined)),
    /**
     * §20 — the username of the one account that controls the AI assistant
     * (its key, switch, caps, who may use it, what it costs). Read at start
     * while no owner is pinned yet: the live, active account of that name is
     * pinned for good, and a later change here only logs a warning. Until then
     * the name is reserved in the app; `npm run ai:pin-owner -w server --
     * <username>` pins an existing account instead (ai/owner.ts).
     */
    AI_OWNER_USERNAME: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : 'beda')),
    /**
     * §21 — whether this instance runs the automations engine (watches,
     * scheduled reports, follow-up escalation). On by default; several
     * instances may all run it, a database lease keeps each run to one.
     * Switched off, automations stay as they are and wait.
     */
    AUTOMATIONS_ENABLED: bool.default(true),
    /**
     * §24 — push notifications to phones and computers, with the app closed.
     * On by default. The VAPID keys are made and kept in the database unless
     * set here (both, base64url); VAPID_SUBJECT is how a push service may
     * reach whoever runs the app (mailto: or https:).
     */
    PUSH_ENABLED: bool.default(true),
    VAPID_PUBLIC_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
    VAPID_PRIVATE_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
    VAPID_SUBJECT: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .refine((v) => v === undefined || /^(mailto:|https:\/\/)/.test(v), { message: 'Starts with mailto: or https://' }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.IMAGE_STORAGE_DRIVER === 'azure-blob' && !cfg.AZURE_STORAGE_CONNECTION_STRING) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AZURE_STORAGE_CONNECTION_STRING'],
        message: 'Required when IMAGE_STORAGE_DRIVER=azure-blob',
      })
    }
    if (cfg.NODE_ENV === 'production' && cfg.IMAGE_STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IMAGE_STORAGE_DRIVER'],
        message:
          'The local image driver is not durable on Azure App Service. Use azure-blob in production.',
      })
    }
  })

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`)
  }
  return parsed.data
}
