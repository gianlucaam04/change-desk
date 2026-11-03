// change-desk: band, pane, undo per prompt
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Meter } from '../types'

const PANE = 'change-desk'
const changes = atom({ plugin: 'change-desk', key: 'changes' } as const, [], {
  shape: 'changes-3',
})
const meter = atom({ plugin: 'change-desk', key: 'meter' } as const, null, {
  shape: 'meter-3',
})
const lastPrompt = atom({ plugin: 'change-desk', key: 'prompt' } as const, '', {
  shape: 'prompt-1',
})
const turnNo = atom({ plugin: 'change-desk', key: 'turn' } as const, 0, {
  shape: 'turn-1',
})

const LABELS: Record<string, string> = {
  five_hour: 'Sessione 5h',
  seven_day: 'Settimana',
  spend_limit: 'Budget',
}

const resetIn = (iso?: string) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000))
  if (mins >= 1440) return `reset ${Math.floor(mins / 1440)}g ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `reset ${Math.floor(mins / 60)}h ${mins % 60}m` : `reset ${mins}m`
}

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const refresh = async ($: any) => {
  const u = await $.session.usage()
  const m: Meter = {
    percent: Math.round(u.context.percent ?? 0),
    tokens: u.context.tokens ?? 0,
    window: u.context.window,
    usd: u.cost?.usd ?? 0,
    limits: (u.rateLimits ?? []).map((l: any) => ({
      kind: l.kind,
      percent: Math.round(l.percentUsed),
      resetsAt: l.resetsAt,
    })),
    isStale: false,
  }
  // The server sends the limits with its first answer: until then show the
  // last ones any session saw, marked stale.
  if (m.limits.length > 0) {
    await $.store.set('limits', m.limits)
  } else {
    const saved = await $.store.get('limits')
    if (Array.isArray(saved) && saved.length > 0) {
      m.limits = saved as Meter['limits']
      m.isStale = true
    }
  }
  await update($, meter, () => m)
}

// Riporta i file a com'erano prima delle voci date. Dal prompt più recente al
// più vecchio, così per un file toccato più volte vince lo stato più antico.
const undoEntries = async ($: any, entries: Change[]) => {
  const ordered = [...entries].sort((a, b) => b.turn - a.turn)
  for (const c of ordered) {
    if (c.before === null) {
      await $.process.run(['rm', '-f', c.path])
    } else {
      await $.fs.write(c.path, c.before)
    }
  }
  const keys = new Set(entries.map(c => `${c.path}#${c.turn}`))
  await update($, changes, list =>
    list.map(one => (keys.has(`${one.path}#${one.turn}`) ? { ...one, isUndone: true } : one)),
  )
  $.ui.toast(`Annullato: ${new Set(entries.map(c => c.path)).size} file`)
}

const tone = (percent: number) =>
  percent < 60 ? 'success' : percent < 85 ? 'warning' : 'error'

// Silent style: grey while healthy, colored only when it needs attention.
const alert = (percent: number) =>
  percent < 60 ? undefined : percent < 85 ? 'warning' : 'error'

const bar = (percent: number, width = 12) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'change-desk',
      description: 'Apri il pannello dei file modificati da Claude',
    })
    void $.ui.open({ id: PANE, title: 'Modifiche' })
    const started = await next(e)
    void refresh($).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'change-desk' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Modifiche' })
    return { text: 'Pannello Modifiche aperto.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, turnNo, n => n + 1)
    await update($, lastPrompt, () => e.text)
    return next(e)
  })

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const path = e.file_path
      const turn = await read($, turnNo)
      const prompt = await read($, lastPrompt)
      const list = await read($, changes)
      const known = list.find(c => c.path === path && c.turn === turn && !c.isUndone)
      if (known) {
        await update($, changes, l =>
          l.map(c => (c === known ? { ...c, edits: c.edits + 1 } : c)),
        )
      } else {
        const before = (await $.fs.exists(path))
          ? ((await $.fs.read(path)) as string)
          : null
        const c: Change = { path, tool, before, edits: 1, isUndone: false, turn, prompt }
        await update($, changes, l => [...l, c].slice(-200))
      }
      const ran = await next(e)
      await refresh($)
      return ran
    })
  }

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await refresh($)
    return measured
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = (await read($, changes)).filter(c => !c.isUndone)
    const paths = [...new Set(all.map(c => c.path))]
    const m = await read($, meter)
    const cols = e.props.bodyColumns ?? 40
    const width = cols >= 56 ? 12 : 8
    const isWide = cols >= 48

    const meterRow = (key: string, label: string, percent: number, note: string) => (
      <Box key={key} gap={1}>
        <Box width={14}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text color={alert(percent)} dimColor={percent < 60}>
          {bar(percent, width)}
        </Text>
        <Box width={5}>
          <Text color={alert(percent)} dimColor={percent < 60} bold={percent >= 60}>
            {percent}%
          </Text>
        </Box>
        {isWide && <Text dimColor>{note}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Text bold>Utilizzo</Text>
          {m === null && <Text dimColor>In attesa dei dati…</Text>}
          {m !== null &&
            m.limits.map(l =>
              meterRow(
                l.kind,
                LABELS[l.kind] ?? l.kind,
                l.percent,
                m.isStale ? 'ultimo dato' : resetIn(l.resetsAt),
              ),
            )}
          {m !== null &&
            meterRow('ctx', 'Contesto chat', m.percent, `${tokens(m.tokens)} / ${tokens(m.window)}`)}
          {m !== null && (
            <Box gap={1}>
              <Box width={14}>
                <Text dimColor>Costo sessione</Text>
              </Box>
              <Text dimColor>${m.usd.toFixed(2)}</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold>File modificati</Text>
            <Text dimColor> · {paths.length}</Text>
          </Text>
          {paths.length === 0 && <Text dimColor>Nessuna modifica in questa sessione.</Text>}
          {paths.map(path => {
            const mine = all.filter(c => c.path === path)
            const isNew = mine[0].before === null
            const parts = path.split('/')
            const name = parts[parts.length - 1]
            const folder = parts.length > 1 ? parts[parts.length - 2] + '/' : ''
            const edits = mine.reduce((n, c) => n + c.edits, 0)
            return (
              <Box key={path} gap={1}>
                <Text color={isNew ? 'success' : undefined} dimColor={!isNew}>
                  {isNew ? '+' : '~'}
                </Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">
                    {name}
                    {folder !== '' && <Text dimColor>  {folder}</Text>}
                  </Text>
                </Box>
                {edits > 1 && <Text dimColor>×{edits}</Text>}
                <Button key={`u-${path}`} variant="secondary" onPress={() => undoEntries($, mine)}>
                  <Text>{isWide ? '↺ Annulla' : '↺'}</Text>
                </Button>
              </Box>
            )
          })}
          {paths.length > 0 && (
            <Text dimColor>↺ riporta il file a com'era prima delle modifiche di Claude.</Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, changes)
    const files = new Set(list.filter(c => !c.isUndone).map(c => c.path)).size
    const m = await read($, meter)

    // full from 110 columns, compact from 70 (two chats side by side), minimal below
    const cols = e.viewport?.columns ?? 120
    const size = cols >= 110 ? 'full' : cols >= 70 ? 'compact' : 'minimal'
    const isFull = size === 'full'
    const limits = (m?.limits ?? []).filter(l => size !== 'minimal' || l.kind === 'five_hour')
    const short = (kind: string) =>
      kind === 'five_hour' ? '5h' : kind === 'seven_day' ? (isFull ? 'sett.' : '7g') : '$'

    const dot = () => <Text dimColor>{isFull ? '  ·  ' : '  '}</Text>
    const tip = (text: string) => (
      <Box
        position="absolute"
        top={0}
        left={-(text.length + 3)}
        display="none"
        hover={{ display: 'flex' }}
        paddingX={1}
      >
        <Text bold color="text">
          {text}
        </Text>
      </Box>
    )
    const action = (id: string, icon: string, label: string, hint: string, onPress: () => unknown) => (
      <Box key={`b-${id}`}>
        <Button key={id} variant="secondary" onPress={onPress}>
          <Text>{isFull ? `${icon} ${label}` : icon}</Text>
        </Button>
        {tip(hint)}
      </Box>
    )

    return (
      <Box justifyContent="space-between" paddingX={1}>
        <Text wrap="truncate">
          <Text dimColor>
            ✎ {files}
            {isFull ? ' file' : ''}
          </Text>
          {m !== null && (
            <Text>
              {size !== 'minimal' && (
                <Text>
                  {dot()}
                  {isFull && <Text dimColor>chat </Text>}
                  <Text color={alert(m.percent)} dimColor={m.percent < 60} bold={m.percent >= 60}>
                    {m.percent}%
                  </Text>
                </Text>
              )}
              {limits.map(l => (
                <Text key={l.kind}>
                  {dot()}
                  <Text dimColor>{short(l.kind)} </Text>
                  {m.isStale ? (
                    <Text dimColor>~{l.percent}%</Text>
                  ) : (
                    <Text color={alert(l.percent)} dimColor={l.percent < 60} bold={l.percent >= 60}>
                      {l.percent}%
                    </Text>
                  )}
                </Text>
              ))}
              {isFull && (
                <Text>
                  {dot()}
                  <Text dimColor>${m.usd.toFixed(2)}</Text>
                </Text>
              )}
            </Text>
          )}
        </Text>
        <Box gap={1} flexShrink={0}>
          {action('panel', '▤', 'Pannello', 'Apre il pannello con file, consumi e contesto', () =>
            $.ui.open({ id: PANE, title: 'Modifiche' }),
          )}
          {action('compact', '⇣', 'Compact', 'Riassume la chat per liberare contesto', async () => {
            $.ui.toast('Compattazione in corso…')
            try {
              const r = await $.session.compact()
              $.ui.toast(r.skip ? 'Compact non eseguito' : 'Conversazione compattata')
            } catch {
              $.ui.toast('Compact non possibile mentre Claude lavora')
            }
            await refresh($)
          })}
          {action('handoff', '⇢', 'Handoff', 'Passa il lavoro a una nuova sessione', () =>
            $.prompt.fill({
              text: 'Fai un handoff: passa il lavoro in corso a una nuova sessione con un riepilogo di cosa resta da fare.',
            }),
          )}
        </Box>
      </Box>
    )
  })
}
