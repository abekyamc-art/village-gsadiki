import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@blinkdotnew/sdk'

const app = new Hono()
app.use('*', cors())

const AI_COST = 5
const DEFAULT_RETURN_URL = 'https://g-sadiki.blinkpowered.com/'
const PACKS = {
  starter: { coins: 100, amount: 999, product: 'prod_VHeoJq6QuJGZ2y' },
  studio: { coins: 500, amount: 2999, product: 'prod_VHeodXPgbF3KPP' },
  heritage: { coins: 1200, amount: 5999, product: 'prod_VHeoakjsfTnKhQ' },
} as const

type Env = Record<string, string>
type PackId = keyof typeof PACKS

type StripeSession = {
  id: string
  url: string
  metadata?: { user_id?: string; coins?: string }
}

const getBlink = (env: Env) => createClient({
  projectId: env.BLINK_PROJECT_ID,
  secretKey: env.BLINK_SECRET_KEY,
})

function readableError(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

async function requireUser(c: any, blink: ReturnType<typeof getBlink>) {
  const auth = await blink.auth.verifyToken(c.req.header('Authorization'))
  return auth.valid ? auth.userId : null
}

async function stripeRequest<T>(env: Env, path: string, params: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(10000),
  })
  const body = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message || `Stripe returned ${response.status}.`)
  return body
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyStripeSignature(payload: string, signature: string | undefined, secret: string) {
  if (!signature) return false
  const parts = Object.fromEntries(signature.split(',').map((part) => part.split('=')))
  const timestamp = Number(parts.t)
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !parts.v1) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))
  return bytesToHex(signed) === parts.v1
}

async function creditCoins(blink: ReturnType<typeof getBlink>, userId: string, productId: string, coins: number, eventId: string) {
  const transactions = blink.db.table('village_voice_coin_transactions')
  const balances = blink.db.table('village_voice_coin_balances')
  const existing = await transactions.list({ where: { revenuecatEventId: eventId }, limit: 1 })
  if (existing.length > 0) return { duplicate: true, coins: 0 }
  const balanceRows = await balances.list({ where: { userId }, limit: 1 })
  const balance = balanceRows[0]
  const nextCoins = Number(balance?.coins ?? 0) + coins
  if (balance) {
    await balances.update(balance.id, { coins: nextCoins, updatedAt: new Date().toISOString() })
  } else {
    await balances.create({ id: `balance_${userId}`, userId, coins: nextCoins, updatedAt: new Date().toISOString() })
  }
  await transactions.create({ id: `purchase_${eventId}`, userId, productId, coins, revenuecatEventId: eventId })
  return { duplicate: false, coins }
}

app.get('/health', (c) => c.json({ ok: true }))

app.get('/api/ai/balance', async (c) => {
  const env = c.env as Env
  const blink = getBlink(env)
  const userId = await requireUser(c, blink)
  if (!userId) return c.json({ error: 'Sign in to use premium Tavi AI.' }, 401)
  const balances = blink.db.table('village_voice_coin_balances')
  const rows = await balances.list({ where: { userId }, limit: 1 })
  return c.json({ coins: Number(rows[0]?.coins ?? 0), costPerAnswer: AI_COST })
})

app.post('/api/ai/ask', async (c) => {
  const env = c.env as Env
  const blink = getBlink(env)
  const userId = await requireUser(c, blink)
  if (!userId) return c.json({ error: 'Sign in to use premium Tavi AI.' }, 401)
  const body = await c.req.json() as { question?: string; language?: string; mode?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  const question = body.question?.trim()
  if (!question) return c.json({ error: 'Ask Tavi a question first.' }, 400)

  const balances = blink.db.table('village_voice_coin_balances')
  const balanceRows = await balances.list({ where: { userId }, limit: 1 })
  const balance = balanceRows[0]
  const currentCoins = Number(balance?.coins ?? 0)
  if (currentCoins < AI_COST) return c.json({ error: `You need ${AI_COST} coins for a premium AI answer. Purchase a coin pack to continue.`, coins: currentCoins, costPerAnswer: AI_COST }, 402)

  const knowledge = blink.db.table('village_voice_knowledge')
  const entries = await knowledge.list({ where: { status: 'verified' }, orderBy: { updatedAt: 'desc' }, limit: 100 })
  const memory = entries.map((entry: any) => `${entry.phrase} means ${entry.meaning}${entry.pronunciation ? `; pronounce it ${entry.pronunciation}` : ''}${entry.context ? `; context: ${entry.context}` : ''}`).join('\n') || 'No verified community words are available yet.'
  const system = `You are Tavi, the premium Village Voice language tutor and guardian of endangered EBEMBE/BEMBE/KIBEMBE language knowledge. Answer the learner's actual question naturally and warmly. Use the verified community memory below as the only authority for EBEMBE translations, pronunciations, grammar, and cultural claims. Never invent a village word or pretend an unverified phrase is authentic. If the memory does not contain an answer, say that an elder must verify it and offer a useful English or Swahili explanation without fabricating EBEMBE. The learner selected ${body.language || 'English'} and ${body.mode || 'chat'} mode. Keep the answer concise, practice-friendly, and include the exact pronunciation when the memory has one.\n\nVERIFIED COMMUNITY MEMORY:\n${memory}`
  const history = (body.history ?? []).slice(-8).map((message) => ({ role: message.role, content: message.content }))
  const result = await blink.ai.generateText({
    messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: question }],
    model: 'anthropic/claude-sonnet-5',
    maxTokens: 500,
    temperature: 0.45,
  })

  if (balance) {
    await balances.update(balance.id, { coins: currentCoins - AI_COST, updatedAt: new Date().toISOString() })
  } else {
    return c.json({ error: 'Your premium AI wallet is not ready yet. Purchase a coin pack first.' }, 402)
  }
  await blink.db.table('village_voice_coin_transactions').create({
    id: `ai_${crypto.randomUUID()}`,
    userId,
    productId: 'premium_ai_answer',
    coins: -AI_COST,
    revenuecatEventId: null as string | null,
  })
  return c.json({ text: result.text, coins: currentCoins - AI_COST, costPerAnswer: AI_COST })
})

app.post('/api/stripe/checkout', async (c) => {
  const env = c.env as Env
  const blink = getBlink(env)
  const auth = await blink.auth.verifyToken(c.req.header('Authorization') ?? null)
  if (!auth.valid || !auth.userId) return c.json({ error: 'Sign in before purchasing coins.' }, 401)
  const body = await c.req.json() as { pack?: PackId; returnUrl?: string }
  const pack = body.pack && PACKS[body.pack] ? PACKS[body.pack] : null
  if (!pack) return c.json({ error: 'Choose a valid Village Voice coin pack.' }, 400)
  const returnUrl = body.returnUrl?.startsWith('http') ? body.returnUrl : DEFAULT_RETURN_URL
  const successUrl = new URL(returnUrl)
  successUrl.searchParams.set('payment', 'success')
  const cancelUrl = new URL(returnUrl)
  cancelUrl.searchParams.set('payment', 'cancelled')
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', successUrl.toString())
  params.set('cancel_url', cancelUrl.toString())
  params.set('billing_address_collection', 'auto')
  params.set('allow_promotion_codes', 'true')
  params.set('client_reference_id', auth.userId)
  if (auth.email) params.set('customer_email', auth.email)
  params.set('line_items[0][price_data][currency]', 'usd')
  params.set('line_items[0][price_data][product]', pack.product)
  params.set('line_items[0][price_data][unit_amount]', String(pack.amount))
  params.set('line_items[0][quantity]', '1')
  params.set('metadata[user_id]', auth.userId)
  params.set('metadata[coins]', String(pack.coins))
  params.set('metadata[pack]', body.pack || 'starter')
  try {
    const session = await stripeRequest<StripeSession>(env, 'checkout/sessions', params)
    return c.json({ url: session.url, sessionId: session.id })
  } catch (error) {
    return c.json({ error: readableError(error) }, 502)
  }
})

app.post('/api/stripe/webhook', async (c) => {
  const env = c.env as Env
  const payload = await c.req.text()
  if (!(await verifyStripeSignature(payload, c.req.header('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return c.json({ error: 'Invalid Stripe signature.' }, 400)
  }
  const event = JSON.parse(payload) as { id: string; type: string; data?: { object?: StripeSession & { payment_status?: string; metadata?: { user_id?: string; coins?: string; pack?: string } } } }
  if (event.type !== 'checkout.session.completed') return c.json({ received: true })
  const session = event.data?.object
  const userId = session?.metadata?.user_id
  const coins = Number(session?.metadata?.coins ?? 0)
  if (!userId || !coins || session?.payment_status !== 'paid') return c.json({ received: true })
  const blink = getBlink(env)
  await creditCoins(blink, userId, `stripe_${session.metadata?.pack || 'coin_pack'}`, coins, event.id)
  return c.json({ received: true })
})

app.post('/api/revenuecat/webhook', async (c) => {
  const env = c.env as Env
  const authorization = c.req.header('Authorization')
  if (!authorization || authorization !== `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json() as { event?: { id?: string; app_user_id?: string; product_id?: string; type?: string } }
  const event = body.event
  const userId = event?.app_user_id
  const productId = event?.product_id
  if (!event?.id || !userId || !productId || userId.startsWith('$RCAnonymousID:')) return c.json({ received: true })
  const coinMap: Record<string, number> = { coins_100: 100, coins_500: 500, coins_1200: 1200 }
  const coins = Object.entries(coinMap).find(([key]) => productId.includes(key))?.[1]
  const purchaseTypes = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'NON_RENEWING_PURCHASE_RENEWAL']
  if (!coins || !purchaseTypes.includes(event.type ?? '')) return c.json({ received: true })
  const result = await creditCoins(getBlink(env), userId, productId, coins, event.id)
  return c.json({ received: true, ...result })
})

export default app
