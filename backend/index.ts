import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@blinkdotnew/sdk'

const app = new Hono()
app.use('*', cors())

const getBlink = (env: Record<string, string>) => createClient({
  projectId: env.BLINK_PROJECT_ID,
  secretKey: env.BLINK_SECRET_KEY,
})

app.get('/health', (c) => c.json({ ok: true }))

app.post('/api/revenuecat/webhook', async (c) => {
  const env = c.env as Record<string, string>
  const authorization = c.req.header('Authorization')
  if (!authorization || authorization !== `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json() as {
    event?: { id?: string; app_user_id?: string; product_id?: string; type?: string }
  }
  const event = body.event
  const userId = event?.app_user_id
  const productId = event?.product_id
  if (!event?.id || !userId || !productId) return c.json({ received: true })
  if (userId.startsWith('$RCAnonymousID:')) return c.json({ received: true })

  const coinMap: Record<string, number> = {
    coins_100: 100,
    coins_500: 500,
    coins_1200: 1200,
  }
  const coins = Object.entries(coinMap).find(([key]) => productId.includes(key))?.[1]
  const purchaseTypes = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'NON_RENEWING_PURCHASE_RENEWAL']
  if (!coins || !purchaseTypes.includes(event.type ?? '')) {
    return c.json({ received: true })
  }

  const blink = getBlink(env)
  const transactions = blink.db.table('village_voice_coin_transactions')
  const balances = blink.db.table('village_voice_coin_balances')
  const existing = await transactions.list({ where: { revenuecatEventId: event.id }, limit: 1 })
  if (existing.length > 0) return c.json({ received: true, duplicate: true })

  const balanceRows = await balances.list({ where: { userId }, limit: 1 })
  const balance = balanceRows[0]
  const nextCoins = Number(balance?.coins ?? 0) + coins
  if (balance) {
    await balances.update(balance.id, { coins: nextCoins, updatedAt: new Date().toISOString() })
  } else {
    await balances.create({ id: `balance_${userId}`, userId, coins: nextCoins, updatedAt: new Date().toISOString() })
  }
  await transactions.create({
    id: `purchase_${event.id}`,
    userId,
    productId,
    coins,
    revenuecatEventId: event.id,
  })
  return c.json({ received: true, coins })
})

export default app
