import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { z as zz } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { stat } from 'node:fs/promises'

const name = 'agent-messaging'
const inject = ['agents', 'tools', 'storageDomain', 'commands']
const Config = z.object({})

// ── per-session durable state: { enabled, pending[] } ──────────────────────
const pendingItemSchema = zz.object({
  senderId: zz.string(),
  purpose: zz.string(),
  text: zz.string(),
  at: zz.number()
})
const sessionStateSchema = zz.object({
  enabled: zz.boolean(),
  pending: zz.array(pendingItemSchema)
})
const agentMessagingDomain = defineDomain({
  name: 'agent_messaging',
  version: 0,
  tables: { sessions: domainTable(sessionStateSchema) }
})

/**
 * Cross-agent messaging for DeepSeek Harness.
 *
 * Per-session opt-in: each session has its own receive toggle (default off).
 * While a target's toggle is off, `agent_send` queues the message in the
 * target's pending list and returns "对方未开启开关,请请求开启"; the target
 * UI shows a "有一条消息待接收,是否接收?" banner. Accepting (or turning the
 * toggle on) injects the message and auto-enables the toggle.
 *
 * The UI talks to the Host through four per-session commands:
 *   /agent-messaging-toggle     — flip the receive toggle (delivers pending on)
 *   /agent-messaging-status     — read { enabled, pendingCount } (manual only)
 *   /agent-messaging-accept     — accept all pending messages
 *   /agent-messaging-insert     — steer the given text in immediately (works
 *                                 even for subagent sessions, whose composer
 *                                 can only queue)
 *
 * UI state (banner + toggle) is derived from marker messages the Host
 * mirrors into the session log on every state change (queue / accept /
 * toggle): parked in the inbox while the target is idle, spliced into the
 * conversation once it wakes. The client scans the newest marker — no
 * polling, no per-command echo into the conversation.
 */
function apply(ctx) {
  // ── storage domain (async init) ──────────────────────────────────────────
  let table = null
  const domainPromise = ctx.storageDomain.open(agentMessagingDomain)
  domainPromise.then((domain) => {
    table = domain.table('sessions')
    ctx.effect(() => () => {
      domain.close()
    }, 'agent-messaging: domain close')
  }).catch((error) => {
    ctx.logger.error(`agent-messaging: storage domain failed: ${String(error)}`)
  })

  const rowOf = async (sessionId) => {
    await domainPromise
    if (table === null) return { enabled: false, pending: [] }
    const row = table.get(sessionId)
    if (row === void 0) return { enabled: false, pending: [] }
    return { enabled: row.enabled === true, pending: Array.isArray(row.pending) ? row.pending : [] }
  }
  const writeRow = async (sessionId, state) => {
    await domainPromise
    if (table === null) return
    await table.put(sessionId, state)
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  const senderLabel = (agent) => `${agent.id}`

  // Optional services (absent in headless assemblies → degraded discovery).
  const persistence = ctx.get('sessionPersistence')
  const sessionTitles = ctx.get('sessionTitle')

  const fmtTime = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const shortId = (id) => (typeof id === 'string' && id.length > 13 ? `${id.slice(0, 13)}…` : String(id ?? ''))

  /** Display title of one LIVE session (session-title projection, then fallback). */
  const titleOfLive = (agent) => {
    try {
      const snap = sessionTitles?.get(agent.session)
      if (snap && typeof snap.title === 'string' && snap.title.length > 0) return snap.title
    } catch { /* fall through */ }
    try {
      const events = agent.session?.events ?? []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i]
        if (e.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.length > 0) return e.data.title
      }
    } catch { /* ignore */ }
    return ''
  }

  /** Last activity (ms) of one live session: newest event time, else createdAt. */
  const lastActiveOf = (agent) => {
    try {
      const events = agent.session?.events ?? []
      const last = events[events.length - 1]
      if (last && typeof last.time === 'number') return last.time
    } catch { /* ignore */ }
    return agent.session?.header?.createdAt ?? 0
  }

  const describeAgent = (agent) => ({
    id: agent.id,
    live: true,
    status: agent.status,
    title: titleOfLive(agent),
    provider: agent.options?.provider ?? '',
    model: agent.options?.model ?? '',
    cwd: agent.session?.header?.cwd ?? '',
    lastActive: lastActiveOf(agent),
    origin: agent.session?.header?.origin ?? '',
    parent: agent.session?.header?.parentSession ?? ''
  })

  // ── persisted-session discovery (offline, resumable) ─────────────────────
  const persistedCache = { at: 0, headers: null }
  const titleCache = new Map() // id -> { title, at }
  const mtimeCache = new Map() // id -> { mtime, at }
  const CACHE_MS = 60_000

  /** All persisted session headers (cached 60s); [] when persistence is absent. */
  const listPersisted = async () => {
    if (persistence === void 0) return []
    const now = Date.now()
    if (persistedCache.headers !== null && now - persistedCache.at < CACHE_MS) return persistedCache.headers
    try {
      const headers = await persistence.list()
      persistedCache.headers = headers
      persistedCache.at = now
      return headers
    } catch (error) {
      try { ctx.logger?.warn?.('[agent-messaging] persistence.list failed: %s', String(error)) } catch { /* ignore */ }
      return []
    }
  }

  /** File mtime of one persisted session (cached 60s). */
  const mtimeOf = async (header) => {
    const cached = mtimeCache.get(header.id)
    if (cached !== void 0 && Date.now() - cached.at < CACHE_MS) return cached.mtime
    try {
      const loc = persistence?.locate(header)
      if (loc && typeof loc.path === 'string') {
        const st = await stat(loc.path)
        mtimeCache.set(header.id, { mtime: st.mtimeMs, at: Date.now() })
        return st.mtimeMs
      }
    } catch { /* file may be gone */ }
    return header.createdAt ?? 0
  }

  /** Title of one persisted session: last `session/title` event in its raw log (cached). */
  const titleOfPersisted = async (header) => {
    if (persistence === void 0) return ''
    const cached = titleCache.get(header.id)
    if (cached !== void 0 && Date.now() - cached.at < CACHE_MS) return cached.title
    let title = ''
    try {
      const raw = await persistence.readRaw(header.id)
      if (raw && typeof raw.content === 'string') {
        const lines = raw.content.split('\n')
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          if (!lines[i].includes('session/title')) continue
          try {
            const ev = JSON.parse(lines[i])
            if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.length > 0) {
              title = ev.data.title
              break
            }
          } catch { /* skip unparsable line */ }
        }
      }
    } catch { /* unreadable log */ }
    titleCache.set(header.id, { title, at: Date.now() })
    return title
  }

  /** Describe one persisted (offline) session; failures degrade to id-only. */
  const describePersisted = async (header) => ({
    id: header.id,
    live: false,
    status: 'offline',
    title: await titleOfPersisted(header),
    provider: '',
    model: '',
    cwd: header.cwd ?? '',
    lastActive: await mtimeOf(header),
    origin: header.origin ?? '',
    parent: header.parentSession ?? ''
  })

  /** Default model route for resumed agents: mirror the first live agent. */
  const defaultAgentOptions = () => {
    const any = ctx.agents.list()[0]
    const opts = {}
    if (any?.options?.provider) opts.provider = any.options.provider
    if (any?.options?.model) opts.model = any.options.model
    return opts
  }

  /**
   * Resolve a send target: exact live id → unique live prefix → exact
   * persisted id → unique persisted prefix (auto-resume) → failure.
   * Prefix matching tolerates the optional `session-` prefix: both
   * `session-6883…` and `6883…` address the same session.
   */
  const matchesId = (full, input) => {
    if (full.startsWith(input)) return true
    const bare = full.startsWith('session-') ? full.slice('session-'.length) : full
    return bare.startsWith(input)
  }
  const resolveTarget = async (id) => {
    let target = ctx.agents.get(id)
    if (target !== void 0) return { agent: target, resumed: false }
    const live = ctx.agents.list().filter((a) => matchesId(a.id, id))
    if (live.length === 1) return { agent: live[0], resumed: false }
    if (live.length > 1) return { ambiguity: live.map((a) => a.id) }
    const headers = await listPersisted()
    let header = headers.find((h) => h.id === id)
    if (header === void 0) {
      const pre = headers.filter((h) => matchesId(h.id, id))
      if (pre.length === 1) header = pre[0]
      else if (pre.length > 1) return { ambiguity: pre.map((h) => h.id) }
    }
    if (header === void 0) return null
    try {
      await ctx.agents.resume({ resumeSessionId: header.id, agentOptions: defaultAgentOptions() })
      const agent = ctx.agents.get(header.id)
      if (agent !== void 0) return { agent, resumed: true }
      return { resumeFailed: 'resume 后该会话未出现在 live 集合' }
    } catch (error) {
      return { resumeFailed: String(error?.message ?? error) }
    }
  }

  /** Context size of one live session: message count + total text chars. */
  const contextSize = (agent) => {
    let messages = 0
    let chars = 0
    for (const event of agent.session.events ?? []) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      messages += 1
      const content = event.data?.content ?? []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
      }
    }
    return { messages, chars }
  }

  /** Last assistant text of one live session, truncated for a summary. */
  const lastAssistantText = (agent) => {
    const events = agent.session.events ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      const content = event.data?.message?.content ?? []
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
      if (text.length > 0) return boundContextSummary(text)
    }
    return '(无文字回复)'
  }

  // In-flight deliveries for completion summaries: targetId -> [{id, senderId, purpose, at}]
  const inFlight = new Map()
  // Delivery ids already reported (bounded), so one delivery can never echo twice.
  const sentReportKeys = new Set()

  const buildMessage = (senderId, purpose, text) => {
    const prefix = `[来自 ${senderId} · 目的: ${boundContextSummary(purpose)}]`
    return createUserMessage({
      content: [{ type: 'text', text: `${prefix}\n\n${text}` }],
      source: {
        kind: 'plugin',
        plugin: 'agent-messaging',
        form: 'context'
      }
    })
  }

  const deliver = (target, senderId, purpose, text) => {
    const entry = inFlight.get(target.id) ?? []
    entry.push({
      id: `${senderId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      senderId,
      purpose,
      at: Date.now()
    })
    inFlight.set(target.id, entry)
    target.send(buildMessage(senderId, purpose, text), 'next-turn', true)
  }

  // ── session commands for the client UI ───────────────────────────────────
  ctx.commands.register({
    name: 'agent-messaging-status',
    description: 'read the agent-messaging receive state (enabled, pending count)',
    input: { hint: '[status]' },
    handler: async (invocation) => {
      const state = await rowOf(invocation.agent.id)
      return {
        kind: 'success',
        text: `agent-messaging: ${state.enabled ? '接收中' : '未接收'} · 待接收 ${state.pending.length} 条`
      }
    }
  })

  ctx.commands.register({
    name: 'agent-messaging-toggle',
    description: 'flip the agent-messaging receive toggle for this session',
    input: { hint: '[status]' },
    handler: async (invocation) => {
      const state = await rowOf(invocation.agent.id)
      state.enabled = !state.enabled
      const next = state.enabled
      const target = ctx.agents.get(invocation.agent.id)
      let accepted = 0
      // Turning receiving ON while messages sit pending delivers them all.
      if (next && state.pending.length > 0 && target !== void 0) {
        const items = state.pending.splice(0)
        accepted = items.length
        for (const item of items) deliver(target, item.senderId, item.purpose, item.text)
      }
      await writeRow(invocation.agent.id, state)
      // Marker drives the client projection (banner + toggle). Turning OFF
      // with pending items still unaccepted injects no marker so the accept
      // banner stays visible.
      let marker = ''
      if (accepted > 0) marker = `[agent-messaging] 已接收 ${accepted} 条待接收消息,接收已开启。`
      else if (next) marker = '[agent-messaging] 接收已开启。'
      else if (state.pending.length === 0) marker = '[agent-messaging] 接收已关闭。'
      if (marker !== '' && target !== void 0) {
        target.inject(createUserMessage({
          content: [{ type: 'text', text: marker }],
          source: { kind: 'plugin', plugin: 'agent-messaging', form: 'context' }
        }))
      }
      return {
        kind: 'success',
        text: `agent-messaging: ${next ? '接收中' : '未接收'}${accepted > 0 ? `,已接收 ${accepted} 条待接收消息` : ''}`
      }
    }
  })

  ctx.commands.register({
    name: 'agent-messaging-accept',
    description: 'accept all pending agent-messaging messages for this session',
    input: { hint: '[status]' },
    handler: async (invocation) => {
      const state = await rowOf(invocation.agent.id)
      const items = state.pending.splice(0)
      if (items.length === 0) return { kind: 'success', text: 'agent-messaging: no pending message' }
      state.enabled = true
      await writeRow(invocation.agent.id, state)
      const target = ctx.agents.get(invocation.agent.id)
      let delivered = 0
      if (target !== void 0) {
        for (const item of items) {
          deliver(target, item.senderId, item.purpose, item.text)
          delivered += 1
        }
        // Marker drives the client projection: banner hides, toggle shows on.
        target.inject(createUserMessage({
          content: [{ type: 'text', text: `[agent-messaging] 已接收 ${items.length} 条待接收消息,接收已开启。` }],
          source: { kind: 'plugin', plugin: 'agent-messaging', form: 'context' }
        }))
      }
      const senders = [...new Set(items.map((item) => item.senderId))].join(', ')
      return {
        kind: 'success',
        text: delivered > 0
          ? `agent-messaging: accepted ${items.length} message(s) from ${senders}`
          : `agent-messaging: accepted, but target not live (from ${senders})`
      }
    }
  })

  ctx.commands.register({
    name: 'agent-messaging-insert',
    description: 'insert the given text into this session immediately (steer): a running turn consumes it at its next step boundary, an idle session starts a turn. Works even for subagent sessions, whose composer can only queue.',
    input: { hint: '<text>' },
    handler: async (invocation) => {
      const text = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      if (text === '') {
        return { kind: 'success', text: 'agent-messaging-insert: 内容为空(用法:/agent-messaging-insert <要插入的消息>)' }
      }
      const agent = ctx.agents.get(invocation.agent.id)
      if (agent === void 0) return { kind: 'success', text: 'agent-messaging-insert: agent not live' }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'agent-messaging', form: 'context' }
      })
      agent.steer(message)
      return { kind: 'success', text: `agent-messaging-insert: 已插入(${text.slice(0, 40)})— 运行中将在下一 step 消费,空闲则开启新回合` }
    }
  })

  // ── tools ────────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_list',
    description: 'List every addressable session for messaging: live agents (id, status, provider, model, title, workspace, last activity) plus persisted offline sessions that agent_send can auto-resume. Read-only; the list never authorizes delivery by itself.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            live: { type: 'boolean', required: true },
            status: { type: 'string', required: true },
            title: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            cwd: { type: 'string' },
            lastActive: { type: 'number' },
            origin: { type: 'string' },
            parent: { type: 'string' }
          }
        }
      },
      render: (_args, value) => {
        const live = value.filter((v) => v.live)
        const offline = value.filter((v) => !v.live)
        const lines = []
        lines.push(`live ${live.length}:`)
        if (live.length === 0) lines.push('- (none)')
        for (const a of live) {
          lines.push(`- [${a.status}] ${a.title || '(无标题)'} ${shortId(a.id)} · ${a.cwd || '?'} · ${fmtTime(a.lastActive)} · ${a.provider} ${a.model}`)
        }
        if (offline.length > 0) {
          lines.push(`离线可恢复(agent_send 自动唤醒) ${offline.length}:`)
          for (const a of offline) {
            lines.push(`- ${a.title || '(无标题)'} ${shortId(a.id)} · ${a.cwd || '?'} · ${fmtTime(a.lastActive)}${a.origin ? ' · 子代理' : ''}${a.parent ? ` ← ${shortId(a.parent)}` : ''}`)
          }
        }
        return [{
          type: 'text',
          text: lines.join('\n')
        }]
      }
    },
    async execute() {
      const live = ctx.agents.list().map(describeAgent)
      const liveIds = new Set(live.map((a) => a.id))
      let offline = []
      if (persistence !== void 0) {
        const headers = await listPersisted()
        const unseen = headers.filter((h) => !liveIds.has(h.id))
        // Sort by mtime desc, then read titles (cached) with a bounded concurrency.
        const withTime = await Promise.all(unseen.map(async (h) => ({ h, mtime: await mtimeOf(h) })))
        withTime.sort((a, b) => b.mtime - a.mtime)
        const top = withTime.slice(0, 40)
        offline = await Promise.all(top.map(async ({ h }) => describePersisted(h)))
        if (withTime.length > top.length) {
          offline.push({ id: `… 另有 ${withTime.length - top.length} 个更早的会话,可用 agent_send 前缀寻址`, live: false, status: 'offline', title: '', provider: '', model: '', cwd: '', lastActive: 0, origin: '', parent: '' })
        }
      }
      return [...live, ...offline].sort((a, b) => b.lastActive - a.lastActive)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'agent_send',
    description: 'Send one message to an addressable agent session by id (full or unique prefix; see agent_list), waking it so the text arrives as its next turn input. Targets may be live agents or persisted offline sessions, which are auto-resumed before delivery. Per-session receive toggle: if the target has not enabled messaging, the message is queued as pending and you get "对方未开启开关,请请求开启" — the target can accept it from its UI banner. Returns the delivery result; a missing/ambiguous target is a clear failure, never a throw.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Target session id — full id or a unique prefix (from agent_list).'
      },
      text: {
        type: 'string',
        required: true,
        description: 'The message content to deliver.'
      },
      purpose: {
        type: 'string',
        description: 'One short line stating why you are sending this, shown to the recipient as a prefix.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          delivered: { type: 'boolean', required: true },
          queued: { type: 'boolean', required: true },
          resumed: { type: 'boolean' },
          detail: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.detail
      }]
    },
    async execute(args, exec) {
      const sender = exec?.agent ?? null
      if (sender === null) return { ok: false, delivered: false, queued: false, detail: 'agent_send requires a calling agent (exec.agent was undefined)' }
      const resolved = await resolveTarget(String(args.id))
      if (resolved === null) {
        return {
          ok: false, delivered: false, queued: false,
          detail: `找不到目标会话 "${args.id}":它既不在 live 集合,也不在持久化会话列表。请用 agent_list 查看可寻址会话(支持 id 前缀)。`
        }
      }
      if (resolved.ambiguity !== void 0) {
        return {
          ok: false, delivered: false, queued: false,
          detail: `目标前缀 "${args.id}" 不唯一,匹配:${resolved.ambiguity.map(shortId).join(', ')}。请用更长的前缀或完整 id。`
        }
      }
      if (resolved.resumeFailed !== void 0) {
        return {
          ok: false, delivered: false, queued: false,
          detail: `目标会话 "${args.id}" 恢复失败:${resolved.resumeFailed}。可在 UI 中直接打开该会话后再试。`
        }
      }
      const target = resolved.agent
      if (target.id === sender.id) return { ok: false, delivered: false, queued: false, detail: `cannot send to yourself (${sender.id})` }
      const purpose = typeof args.purpose === 'string' && args.purpose.length > 0 ? args.purpose : '(未说明目的)'
      const state = await rowOf(target.id)
      if (!state.enabled) {
        // Queue as pending; the target UI shows the accept banner.
        state.pending.push({ senderId: sender.id, purpose, text: args.text, at: Date.now() })
        await writeRow(target.id, state)
        // Also notify the target model (non-waking) so it may ask the user.
        const notice = createUserMessage({
          content: [{ type: 'text', text: `[agent-messaging] 有一条待接收消息(共 ${state.pending.length} 条),来自 ${senderLabel(sender)}。发送方请求开启接收。` }],
          source: {
            kind: 'plugin',
            plugin: 'agent-messaging',
            form: 'context'
          }
        })
        target.inject(notice)
        return {
          ok: true, delivered: false, queued: true, resumed: resolved.resumed === true,
          detail: `queued for ${target.id}${resolved.resumed ? '(已从历史会话恢复)' : ''}: 对方未开启开关,请请求开启(消息已进入待接收队列)`
        }
      }
      deliver(target, sender.id, purpose, args.text)
      return {
        ok: true, delivered: true, queued: false, resumed: resolved.resumed === true,
        detail: `delivered to ${target.id}${resolved.resumed ? '(已从历史会话恢复)' : ''} (${target.status}) as its next turn`
      }
    }
  }))

  // ── completion summary: after the recipient settles a turn that consumed ──
  // ── one of our messages, inject a summary to the sender (no wake) ────────
  // NOTE: 'agent/turn-stopping' is a SERIAL event (payload only — no `next`
  // waterfall callback). Its listeners run inside the agent-loop turn driver,
  // where ANY thrown error is caught by the loop and turns the whole round
  // into a failure ("本轮运行失败"). This handler must therefore NEVER throw:
  // every step is guarded, and one delivery can never report twice.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    try {
      const deliveries = inFlight.get(agent.id)
      if (deliveries === void 0 || deliveries.length === 0) return
      const delivery = deliveries.shift()
      if (deliveries.length === 0) inFlight.delete(agent.id)
      if (delivery === void 0) return
      if (sentReportKeys.has(delivery.id)) return
      sentReportKeys.add(delivery.id)
      if (sentReportKeys.size > 256) sentReportKeys.clear()
      const sender = ctx.agents.get(delivery.senderId)
      if (sender === void 0 || typeof sender.inject !== 'function') return
      const size = contextSize(agent)
      const did = lastAssistantText(agent)
      const summary = [
        `完成汇报(来自 ${agent.id}, 你于 ${new Date(delivery.at).toLocaleTimeString()} 派发)`,
        `目的: ${delivery.purpose}`,
        `对方做了什么: ${did}`,
        `上下文规模: ${size.messages} 条消息 / ${size.chars} 字符`
      ].join('\n')
      const notice = createUserMessage({
        content: [{ type: 'text', text: summary }],
        source: {
          kind: 'plugin',
          plugin: 'agent-messaging',
          form: 'context'
        }
      })
      sender.inject(notice)
    } catch (error) {
      // Never let a summary failure fail the recipient's turn.
      try {
        ctx.logger?.warn?.('[agent-messaging] turn-stopping summary failed: %s', String(error))
      } catch { /* ignore */ }
    }
  })
}

export { apply, Config, inject, name }
