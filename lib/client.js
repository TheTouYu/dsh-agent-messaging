window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-agent-messaging',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react_jsx_runtime = require('react/jsx-runtime')
    let react = require('react')

    const inject = ['slots', 'sessions', 'locale']

    const NS = 'agentMessaging'
    const zh = {
      'toggle.aria': '模型互发消息接收开关',
      'toggle.on': '接收中',
      'toggle.off': '未接收',
      'banner.title': '有一条消息待接收',
      'banner.body': '是否接收?接收后开关将自动打开。',
      'banner.accept': '接收',
      'banner.accepting': '接收中…',
      'pending.count': '({count} 条)',
      'insert.label': '插入',
      'insert.aria': '立即插入(打断当前任务)',
      'insert.title': '插入:立即处理(子代理会话输入框只能排队,用此按钮打断插入)',
      'insert.empty': '输入框为空',
      'insert.done': '已插入'
    }
    const en = {
      'toggle.aria': 'Agent messaging receive toggle',
      'toggle.on': 'Receiving',
      'toggle.off': 'Not receiving',
      'banner.title': 'One message is pending',
      'banner.body': 'Accept it? The toggle turns on automatically.',
      'banner.accept': 'Accept',
      'banner.accepting': 'Accepting…',
      'pending.count': '({count})',
      'insert.label': 'Insert',
      'insert.aria': 'Insert now (interrupt the running task)',
      'insert.title': 'Insert: process immediately (subagent composers can only queue; this button steers)',
      'insert.empty': 'Input is empty',
      'insert.done': 'Inserted'
    }

    // ── context to pass the sessions service + locale down ──────────────────
    const MessagingSessionsContext = react.createContext(null)
    const MessagingLocaleContext = react.createContext(null)

    // ── marker scan: newest agent-messaging marker visible to this session ──
    // The host mirrors every state change (queue / accept / toggle) as a
    // marker message. While the target is idle the marker sits parked in its
    // inbox (mirrored in snapshot.queue); once the agent wakes it is spliced
    // into the conversation as a context node. Parked items are always newer
    // than anything already spliced, so the queue marker wins when present.
    // No polling, no command echo, nothing hidden that can drift.
    const textOf = (content) => (Array.isArray(content) ? content : [])
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text).join('')

    const lastMarkerSelector = (snap) => {
      let queueMarker = ''
      const queue = snap?.queue ?? []
      for (const item of queue) {
        const text = typeof item.text === 'string' ? item.text : textOf(item.content)
        if (text.startsWith('[agent-messaging]')) queueMarker = text
      }
      let nodeMarker = ''
      const chat = snap?.chat
      if (chat !== void 0) {
        const order = chat.order ?? []
        for (let i = order.length - 1; i >= 0; i -= 1) {
          const n = chat.nodes.get(order[i])
          if (n === void 0 || n.kind !== 'context') continue
          const data = n.data
          const src = data?.source
          if (src === null || typeof src !== 'object') continue
          if (src.kind === 'plugin' && src.plugin === 'agent-messaging') {
            nodeMarker = textOf(data?.content)
            break
          }
        }
      }
      return queueMarker !== '' ? queueMarker : nodeMarker
    }

    // ── header action: the receive toggle ──────────────────────────────────
    function ReceiveToggle({ sessionId, useSession }) {
      const sessions = react.useContext(MessagingSessionsContext)
      const t = react.useContext(MessagingLocaleContext)
      const markerText = useSession(lastMarkerSelector)
      const [local, setLocal] = react.useState(null)
      const enabled = local !== null ? local : /接收已开启|已接收/.test(markerText)
      const toggle = () => {
        const session = sessions.binding(sessionId)?.session
        if (session === void 0) return
        const next = !enabled
        setLocal(next)
        session.command('/agent-messaging-toggle').then((result) => {
          if (!result.ok) setLocal(null)
        }).catch(() => setLocal(null))
      }
      return react_jsx_runtime.jsx('button', {
        type: 'button',
        'aria-label': t('toggle.aria'),
        'aria-pressed': enabled,
        title: enabled ? t('toggle.on') : t('toggle.off'),
        onClick: toggle,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '28px',
          padding: '0 8px',
          borderRadius: '14px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: enabled ? 'var(--dsw-alias-state-success-tertiary)' : 'transparent',
          color: enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
          cursor: 'pointer',
          fontSize: '12px',
          lineHeight: '18px'
        },
        children: enabled ? t('toggle.on') : t('toggle.off')
      })
    }

    // ── pending banner above the composer ──────────────────────────────────
    // Shows while the last marker is a queue notice; hides as soon as the
    // accept marker lands. The Accept button runs the command once — no
    // interval, no status echo.
    function PendingBanner({ sessionId, useSession }) {
      const sessions = react.useContext(MessagingSessionsContext)
      const t = react.useContext(MessagingLocaleContext)
      const markerText = useSession(lastMarkerSelector)
      const m = markerText.match(/共 (\d+) 条/)
      const pendingCount = markerText.startsWith('[agent-messaging] 有一条待接收') ? (m !== null ? Number(m[1]) : 1) : 0
      const [accepting, setAccepting] = react.useState(false)
      const [accepted, setAccepted] = react.useState(false)
      const session = sessions.binding(sessionId)?.session

      if (pendingCount === 0 || accepted) return null
      const accept = () => {
        if (session === void 0) return
        setAccepting(true)
        session.command('/agent-messaging-accept').then((result) => {
          setAccepting(false)
          if (result.ok) setAccepted(true)
        }).catch(() => setAccepting(false))
      }
      return react_jsx_runtime.jsx('div', {
        role: 'status',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          margin: '0 auto 6px',
          maxWidth: 'calc(var(--dsh-chat-content-width, 748px) + 32px)',
          padding: '8px 12px',
          borderRadius: '12px',
          border: '1px solid var(--dsw-alias-state-warn-secondary)',
          background: 'var(--dsw-specific-tip)',
          fontSize: '13px',
          lineHeight: '20px'
        },
        children: [
          react_jsx_runtime.jsx('span', {
            style: { flex: 1, minWidth: 0 },
            children: `${t('banner.title')} ${pendingCount > 1 ? t('pending.count', { count: pendingCount }) : ''} — ${t('banner.body')}`
          }),
          react_jsx_runtime.jsx('button', {
            type: 'button',
            disabled: accepting,
            onClick: accept,
            style: {
              flex: 'none',
              height: '26px',
              padding: '0 12px',
              borderRadius: '13px',
              border: 'none',
              background: 'var(--dsw-alias-state-warn-primary)',
              color: 'var(--dsw-alias-label-inverse)',
              cursor: accepting ? 'default' : 'pointer',
              opacity: accepting ? 0.6 : 1,
              fontSize: '12px',
              lineHeight: '26px'
            },
            children: accepting ? t('banner.accepting') : t('banner.accept')
          })
        ]
      })
    }

    // ── insert button: immediate steer for any session ─────────────────────
    // A subagent session's composer can only queue (its transport routes
    // through the parent session, no steer mode), so the Ctrl/Cmd+Enter
    // insertion shortcut silently degrades to queue. This button sends the
    // current draft through the Host's /agent-messaging-insert command, which
    // uses agent.steer() directly — a running turn consumes it at its next
    // step boundary. Always shown (harmless extra entry for normal sessions).
    function InsertButton({ sessionId, useSession, useInput, inputActions }) {
      const sessions = react.useContext(MessagingSessionsContext)
      const t = react.useContext(MessagingLocaleContext)
      const draft = useInput((s) => (s ? s.draft : '')) ?? ''
      const [busy, setBusy] = react.useState(false)
      const [done, setDone] = react.useState(false)
      const insert = () => {
        if (draft.trim() === '') return
        const session = sessions.binding(sessionId)?.session
        if (session === void 0) return
        setBusy(true)
        session.command(`/agent-messaging-insert ${draft}`).then((result) => {
          setBusy(false)
          if (result.ok) {
            inputActions.setDraft('')
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          }
        }).catch(() => setBusy(false))
      }
      return react_jsx_runtime.jsx('button', {
        type: 'button',
        'aria-label': t('insert.aria'),
        title: t('insert.title'),
        disabled: busy || draft.trim() === '',
        onClick: insert,
        style: {
          flex: 'none',
          height: '26px',
          padding: '0 10px',
          borderRadius: '13px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: done ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          cursor: busy || draft.trim() === '' ? 'default' : 'pointer',
          fontSize: '12px',
          lineHeight: '26px',
          opacity: busy || draft.trim() === '' ? 0.5 : 1
        },
        children: done ? t('insert.done') : t('insert.label')
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-messaging: dictionaries')
      const t = ctx.locale.bind(NS)
      const sessions = ctx.get('sessions')
      const SessionsProvider = (props) => react_jsx_runtime.jsx(MessagingSessionsContext.Provider, {
        value: sessions,
        children: react_jsx_runtime.jsx(MessagingLocaleContext.Provider, {
          value: t,
          children: props.children
        })
      })

      // Header action: per-session receive toggle.
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-messaging-toggle',
        order: 30,
        locale: NS
      }, (props) => react_jsx_runtime.jsx(SessionsProvider, {
        children: react_jsx_runtime.jsx(ReceiveToggle, {
          sessionId: props.sessionId,
          useSession: props.useSession
        })
      })))

      // Pending banner above the composer.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'agent-messaging-pending',
        order: 10,
        locale: NS
      }, (props) => react_jsx_runtime.jsx(SessionsProvider, {
        children: react_jsx_runtime.jsx(PendingBanner, {
          sessionId: props.sessionId,
          useSession: props.useSession
        })
      })))

      // Insert button in the composer tool row (subagent sessions only).
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'agent-messaging-insert',
        order: 40,
        locale: NS
      }, (props) => react_jsx_runtime.jsx(SessionsProvider, {
        children: react_jsx_runtime.jsx(InsertButton, {
          sessionId: props.sessionId,
          useSession: props.useSession,
          useInput: props.useInput,
          inputActions: props.inputActions
        })
      })))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
