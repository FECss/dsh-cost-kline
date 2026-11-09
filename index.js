/**
 * dsh-cost-kline — Host 侧。
 *
 * 职责：
 *   1. 监听 `session/event`，从每次 `assistant/message` 的 usage 里取 token 数；
 *   2. token 数 × 单价表 = 本次调用花费（CNY），追加到账本（内存 + 磁盘）；
 *   3. 在 ctx.webServer 注册 /dsh-cost-kline/* 路由，供浏览器侧轮询。
 *
 * 说明：DSH 自己不算钱，这里的花费是「token 量 × 可配置单价」的估算，不是官方账单。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-cost-kline'
export const inject = ['webServer']

const VERSION = '0.3.1'
const ROUTE = '/dsh-cost-kline'
const DAY = 86400000
const MAX_SAMPLES = 20000
const DEFAULT_PRICES = { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 3 }

const DEFAULT_CONFIG = {
  currency: 'CNY',
  keepDays: 30,
  prices: {
    default: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 3 },
  },
}

/** 数值兜底：非有限数 → 0 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function priceFor(prices, model) {
  const table = prices && typeof prices === 'object' ? prices : DEFAULT_CONFIG.prices
  const key = typeof model === 'string' ? model : ''
  if (key && table[key] && typeof table[key] === 'object') return { ...DEFAULT_PRICES, ...table[key] }
  const lower = key.toLowerCase()
  for (const name of Object.keys(table)) {
    if (name === 'default') continue
    if (lower && lower.includes(name.toLowerCase()) && typeof table[name] === 'object') {
      return { ...DEFAULT_PRICES, ...table[name] }
    }
  }
  return { ...DEFAULT_PRICES, ...(table.default && typeof table.default === 'object' ? table.default : {}) }
}

function costOf(usage, price) {
  const miss = num(usage.inputTokens)
  const hit = num(usage.cacheReadTokens)
  const write = num(usage.cacheWriteTokens)
  const out = num(usage.outputTokens)
  const writePrice = typeof price.cacheWrite === 'number' ? price.cacheWrite : price.cacheMiss
  return (miss * price.cacheMiss + hit * price.cacheHit + write * writePrice + out * price.output) / 1e6
}

/** 从 assistant message 流里取最后一个带 usage 的 chunk（对应 dsh-llm 的 lastAssistantStreamChunk） */
function streamUsage(stream) {
  if (stream === null || typeof stream !== 'object') return undefined
  const chunks = Array.isArray(stream) ? stream : Array.isArray(stream.chunks) ? stream.chunks : []
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i]
    if (!chunk || typeof chunk !== 'object') continue
    const usage = chunk.usage ?? (chunk.data && chunk.data.usage)
    if (usage && typeof usage === 'object') return usage
  }
  return undefined
}

function usageOf(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return undefined
  if (data.usage && typeof data.usage === 'object') return data.usage
  const fromMessage = data.message && data.message.usage
  if (fromMessage && typeof fromMessage === 'object') return fromMessage
  return streamUsage(data.stream)
}

function modelOf(event) {
  const data = event && event.data
  const source = data && data.message && data.message.source
  const model = source && typeof source.model === 'string' ? source.model : ''
  const provider = source && typeof source.provider === 'string' ? source.provider : ''
  return { provider, model: model || 'unknown' }
}

function sessionIdOf(session) {
  const s = session && typeof session === 'object' ? session : {}
  const id = (s.header && s.header.id) ?? s.id
  return typeof id === 'string' && id ? id : 'unknown'
}

function dataDir() {
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || homedir()
  return join(base, 'dsh-cost-kline')
}

function loadLedger(file, keepDays) {
  try {
    if (!existsSync(file)) return { samples: [], since: Date.now() }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const samples = Array.isArray(raw && raw.samples) ? raw.samples : []
    const cutoff = Date.now() - keepDays * DAY
    return {
      since: typeof raw?.since === 'number' ? raw.since : Date.now(),
      samples: samples
        .filter((s) => Array.isArray(s) && typeof s[0] === 'number' && s[0] >= cutoff)
        .slice(-MAX_SAMPLES),
    }
  } catch {
    return { samples: [], since: Date.now() }
  }
}

export function apply(ctx, config) {
  const settings = {
    currency: (config && config.currency) || DEFAULT_CONFIG.currency,
    keepDays: Number.isFinite(config?.keepDays) ? config.keepDays : DEFAULT_CONFIG.keepDays,
    prices: { ...DEFAULT_CONFIG.prices, ...((config && config.prices) || {}) },
  }
  const file = join(dataDir(), 'ledger.json')
  const ledger = loadLedger(file, settings.keepDays)
  ledger.samples = ledger.samples.slice(-MAX_SAMPLES)
  let saveTimer = null

  const save = () => {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        const dir = dataDir()
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 1, since: ledger.since, samples: ledger.samples }))
        renameSync(tmp, file)
      } catch {
        /* 磁盘不可写不影响实时统计 */
      }
    }, 2000)
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  /** 记录一次调用的花费。sample = [t, cost, tokens, hit, miss, out, model] */
  const record = (event, session) => {
    const usage = usageOf(event)
    if (!usage) return
    const tokens = num(usage.totalTokens) || num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens)
    if (tokens <= 0) return
    const { provider, model } = modelOf(event)
    const price = priceFor(settings.prices, model)
    const cost = costOf(usage, price)
    if (!(cost > 0)) return
    ledger.samples.push([
      Date.now(),
      cost,
      tokens,
      num(usage.cacheReadTokens),
      num(usage.inputTokens),
      num(usage.outputTokens),
      `${provider}/${model}`,
      sessionIdOf(session),
    ])
    if (ledger.samples.length > MAX_SAMPLES) ledger.samples.splice(0, ledger.samples.length - MAX_SAMPLES)
    save()
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const type = event && typeof event === 'object' ? event.type : undefined
          if (type !== 'assistant/message') return
          record(event, session)
        } catch {
          /* 单个事件畸形不影响后续统计 */
        }
      }),
    'dsh-cost-kline: token usage ledger',
  )

  // ---------------- 余额（可选依赖：DSH 账号服务 deepseekAccount） ----------------
  // 没有账号服务时静默降级——面板只显示「余额不可用」，不影响 K 线。
  const BALANCE_TTL = 60000
  const round2 = (v) => Math.round(v * 100) / 100
  const toNum = (v) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : 0
  }

  /** DeepSeek 官方计价时段：北京时间 00:30–08:30 为优惠时段。 */
  const pricingTier = () => {
    const bj = new Date(Date.now() + 8 * 3600000)
    const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
    return minutes >= 30 && minutes < 510 ? 'off-peak' : 'peak'
  }

  let balance = { ok: false, pending: true, at: 0, error: null, wallets: [], tier: pricingTier() }
  let balanceAt = 0
  let balanceBusy = false

  /** 账号快照 → 按币种汇总的余额（total = 充值 + 赠送）。金额全部走字符串原值解析，不伪造 0。 */
  const parseSnapshot = (snap) => {
    if (!snap || snap.status !== 'ready') {
      return { ok: false, pending: false, at: Date.now(), error: '账号余额不可用（未登录或查询失败）', wallets: [], tier: pricingTier() }
    }
    const byCurrency = new Map()
    const bump = (raw, field) => {
      const w = raw && typeof raw === 'object' ? raw : {}
      const currency = typeof w.currency === 'string' && w.currency ? w.currency : 'CNY'
      const row = byCurrency.get(currency) || { currency, toppedUp: 0, granted: 0 }
      row[field] += toNum(w.balance)
      byCurrency.set(currency, row)
    }
    for (const w of Array.isArray(snap.value) ? snap.value : []) bump(w, 'toppedUp')
    for (const w of Array.isArray(snap.bonusWallets) ? snap.bonusWallets : []) bump(w, 'granted')
    const wallets = [...byCurrency.values()].map((r) => ({
      currency: r.currency,
      toppedUp: round2(r.toppedUp),
      granted: round2(r.granted),
      total: round2(r.toppedUp + r.granted),
    }))
    if (wallets.length === 0) {
      return { ok: false, pending: false, at: Date.now(), error: '账号没有可展示的钱包', wallets: [], tier: pricingTier() }
    }
    return { ok: true, pending: false, at: Date.now(), error: null, wallets, tier: pricingTier() }
  }

  const refreshBalance = async (force = false) => {
    const now = Date.now()
    if (balanceBusy) return
    if (!force && balanceAt > 0 && now - balanceAt < BALANCE_TTL) return
    balanceBusy = true
    try {
      const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount', false) : undefined
      if (!account || typeof account.getBalance !== 'function') {
        balance = { ok: false, pending: false, at: now, error: '未检测到 DSH 账号服务', wallets: [], tier: pricingTier() }
        return
      }
      const snap = await account.getBalance({
        version: String(VERSION),
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      balance = parseSnapshot(snap)
    } catch (e) {
      balance = {
        ok: false,
        pending: false,
        at: Date.now(),
        error: e instanceof Error ? e.message : String(e),
        wallets: [],
        tier: pricingTier(),
      }
    } finally {
      balanceAt = Date.now()
      balanceBusy = false
    }
  }

  void refreshBalance(false)
  ctx.effect(() => {
    const timer = setInterval(() => void refreshBalance(false), BALANCE_TTL)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-cost-kline: balance poll')

  const snapshot = () => {
    const now = Date.now()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const todayStart = midnight.getTime()
    const hourAgo = now - 3600000
    const totals = { all: 0, today: 0, hour: 0, tokens: 0, hit: 0, miss: 0, out: 0, calls: 0 }
    const byModel = new Map()
    const bySession = new Map()
    for (const s of ledger.samples) {
      const t = s[0]
      const cost = s[1] || 0
      totals.all += cost
      if (t >= todayStart) totals.today += cost
      if (t >= hourAgo) totals.hour += cost
      totals.tokens += s[2] || 0
      totals.hit += s[3] || 0
      totals.miss += s[4] || 0
      totals.out += s[5] || 0
      totals.calls += 1
      const model = s[6] || 'unknown'
      const m = byModel.get(model) || { model, cost: 0, tokens: 0, calls: 0 }
      m.cost += cost
      m.tokens += s[2] || 0
      m.calls += 1
      byModel.set(model, m)
      const sid = s[7] || 'unknown'
      const sess = bySession.get(sid) || { id: sid, cost: 0, tokens: 0, calls: 0 }
      sess.cost += cost
      sess.tokens += s[2] || 0
      sess.calls += 1
      bySession.set(sid, sess)
    }
    const prompt = totals.hit + totals.miss + 0
    return {
      v: 1,
      // 排障用：先问「你装的是哪一版」，再看数据对不对
      version: VERSION,
      now,
      currency: settings.currency,
      since: ledger.since,
      totals: {
        ...totals,
        cacheHitRate: prompt > 0 ? totals.hit / prompt : null,
      },
      models: [...byModel.values()].sort((a, b) => b.cost - a.cost).slice(0, 6),
      sessions: [...bySession.values()].sort((a, b) => b.cost - a.cost).slice(0, 6),
      prices: settings.prices,
      samples: ledger.samples.slice(-4000),
      balance: { ...balance },
      note: '按 token 量 × 单价表估算，不是官方账单',
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const send = (status, obj) => {
            if (res.destroyed || res.writableEnded) return
            const body = JSON.stringify(obj)
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store',
              'content-length': Buffer.byteLength(body),
            })
            res.end(body)
          }
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sub = url.pathname.slice(ROUTE.length) || '/'
            if (req.method === 'GET' && (sub === '/state' || sub === '/')) return send(200, snapshot())
            if (req.method === 'GET' && sub === '/balance') return send(200, { ...balance })
            if (req.method === 'POST' && sub === '/balance/refresh') {
              await refreshBalance(true)
              return send(200, { ...balance })
            }
            if (req.method === 'POST' && sub === '/reset') {
              ledger.samples.length = 0
              ledger.since = Date.now()
              save()
              return send(200, { ok: true })
            }
            return send(404, { error: 'not found' })
          } catch (e) {
            try {
              send(500, { error: e instanceof Error ? e.message : String(e) })
            } catch {
              /* 连接已断 */
            }
          }
        },
      }),
    'dsh-cost-kline: routes',
  )
}
