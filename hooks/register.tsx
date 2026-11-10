// change-desk: band, pane, undo per prompt
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Meter } from '../types'

const PANE = 'change-desk'
const changes = atom({ plugin: 'change-desk', key: 'changes' } as const, [], {
  shape: 'changes-4',
})
const meter = atom({ plugin: 'change-desk', key: 'meter' } as const, null, {
  shape: 'meter-4',
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

const resetIn = (now: number, iso?: string) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return `reset ${Math.floor(mins / 1440)}g ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `reset ${Math.floor(mins / 60)}h ${mins % 60}m` : `reset ${mins}m`
}

// Lines added and removed between two versions of a file, counted as a bag of
// lines: cheap on big files, and a line that only moved counts as unchanged.
const lineStats = (before: string | null, after: string | null) => {
  const left = new Map<string, number>()
  for (const line of before === null ? [] : before.split('\n')) {
    left.set(line, (left.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of after === null ? [] : after.split('\n')) {
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else added++
  }
  let removed = 0
  for (const n of left.values()) removed += n
  return { added, removed }
}

// How long ago, without a clock time: the mod cannot trust the time zone.
const ago = (now: number, at: number) => {
  const mins = Math.max(0, Math.floor((now - at) / 60000))
  if (mins < 1) return 'ora'
  if (mins < 60) return `${mins}m fa`
  if (mins < 1440) return `${Math.floor(mins / 60)}h fa`
  return `${Math.floor(mins / 1440)}g fa`
}

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

// Refreshes can overlap (a tool call, a measurement, a turn's end): only the
// latest one started may write, so an older reading never overwrites a newer.
let latestRefresh = 0

// `figures` is a measurement's own input when the caller has one; otherwise
// the session is asked.
const refresh = async ($: any, figures?: any) => {
  const mine = ++latestRefresh
  const u = figures ?? (await $.session.usage())
  const now = await $.clock.now()
  const m: Meter = {
    percent: u.context?.percent === undefined ? null : Math.round(u.context.percent),
    tokens: u.context?.tokens ?? 0,
    window: u.context?.window ?? 0,
    usd: u.cost?.usd ?? 0,
    limits: (u.rateLimits ?? []).map((l: any) => ({
      kind: l.kind,
      percent: Math.round(l.percentUsed),
      resetsAt: l.resetsAt,
    })),
    isStale: false,
  }
  // The server sends the limits with its first answer: until then show the
  // last ones any session saw, marked stale, leaving out windows that have
  // reset since (their old figure would be wrong).
  if (m.limits.length > 0) {
    await $.store.set('limits', m.limits)
  } else {
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) {
      const live = (saved as Meter['limits']).filter(
        l => l.resetsAt === undefined || Date.parse(l.resetsAt) > now,
      )
      if (live.length > 0) {
        m.limits = live
        m.isStale = true
      }
    }
  }
  if (mine !== latestRefresh) return
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

  {
    on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
      const tool = e.tool
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
        const c: Change = {
          path,
          tool,
          before,
          edits: 1,
          isUndone: false,
          turn,
          prompt,
          at: await $.clock.now(),
          added: 0,
          removed: 0,
        }
        await update($, changes, l => [...l, c].slice(-200))
      }
      const ran = await next(e)
      // Measure the file against how it was before Claude's first edit to it,
      // and stamp this turn's entry with the time and the count.
      const live = (await read($, changes)).filter(c => c.path === path && !c.isUndone)
      const original = [...live].sort((a, b) => a.turn - b.turn)[0]
      if (original !== undefined) {
        const current = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : null
        const stats = lineStats(original.before, current)
        const at = await $.clock.now()
        await update($, changes, l =>
          l.map(c => (c.path === path && c.turn === turn && !c.isUndone ? { ...c, at, ...stats } : c)),
        )
      }
      await refresh($)
      return ran
    })
  }

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await refresh($, e)
    return measured
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = (await read($, changes)).filter(c => !c.isUndone)
    // Most recently edited first, so what Claude is touching now is on top.
    const lastAt = (path: string) => Math.max(...all.filter(c => c.path === path).map(c => c.at))
    const paths = [...new Set(all.map(c => c.path))].sort((a, b) => lastAt(b) - lastAt(a))
    const m = await read($, meter)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? 40
    const width = cols >= 56 ? 12 : 8
    const isWide = cols >= 48

    const meterRow = (key: string, label: string, percent: number | null, note: string) => (
      <Box key={key} gap={1}>
        <Box width={14} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={percent === null ? undefined : alert(percent)} dimColor={percent === null || percent < 60}>
            {bar(percent ?? 0, width)}
          </Text>
        </Box>
        <Box width={5} flexShrink={0}>
          {percent === null ? (
            <Text dimColor>—</Text>
          ) : (
            <Text color={alert(percent)} dimColor={percent < 60} bold={percent >= 60}>
              {percent}%
            </Text>
          )}
        </Box>
        {isWide && <Text dimColor>{note}</Text>}
      </Box>
    )

    // A row is a sign, the file's name, its lines added and removed, how long
    // ago it changed and the button, all but the name in fixed columns: the
    // name is cut to fit so nothing after it moves.
    const buttonCols = isWide ? 11 : 4
    const statsCols = 10
    const timeCols = isWide ? 6 : 0
    const nameRoom = Math.max(8, cols - 2 - 1 - statsCols - timeCols - buttonCols - 5)
    const fit = (text: string, room: number) =>
      text.length <= room ? text : text.slice(0, Math.max(1, room - 1)) + '…'

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
                m.isStale ? 'ultimo dato' : resetIn(now, l.resetsAt),
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
            const isNew = mine[0]?.before === null
            const parts = path.split('/')
            const name = parts[parts.length - 1] ?? path
            const folder = parts.length > 1 ? (parts[parts.length - 2] ?? '') + '/' : ''
            const latest = [...mine].sort((a, b) => b.at - a.at)[0]
            const shownName = fit(name, nameRoom)
            const folderRoom = nameRoom - shownName.length - 2
            const shownFolder = folder !== '' && folderRoom >= 4 ? fit(folder, folderRoom) : ''
            return (
              <Box key={path} gap={1}>
                <Box width={1} flexShrink={0}>
                  <Text color={isNew ? 'success' : undefined} dimColor={!isNew}>
                    {isNew ? '+' : '~'}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    {shownName}
                    {shownFolder !== '' && <Text dimColor>  {shownFolder}</Text>}
                  </Text>
                </Box>
                <Box width={statsCols} flexShrink={0} justifyContent="flex-end">
                  <Text>
                    <Text color="diffAdded">+{latest?.added ?? 0}</Text>
                    <Text dimColor> </Text>
                    <Text color="diffRemoved">−{latest?.removed ?? 0}</Text>
                  </Text>
                </Box>
                {isWide && (
                  <Box width={timeCols} flexShrink={0} justifyContent="flex-end">
                    <Text dimColor>{latest === undefined ? '' : ago(now, latest.at)}</Text>
                  </Box>
                )}
                <Box width={buttonCols} flexShrink={0} justifyContent="flex-end">
                  <Button key={`u-${path}`} variant="secondary" onPress={() => undoEntries($, mine)}>
                    <Text>{isWide ? '↺ Annulla' : '↺'}</Text>
                  </Button>
                </Box>
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
                  {m.percent === null ? (
                    <Text dimColor>—</Text>
                  ) : (
                    <Text color={alert(m.percent)} dimColor={m.percent < 60} bold={m.percent >= 60}>
                      {m.percent}%
                    </Text>
                  )}
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
            // Sent as if typed: the app runs /compact itself, and queues it
            // when a turn is still running instead of refusing.
            try {
              await $.prompt.submit({ text: '/compact', asUser: true })
            } catch (err) {
              $.ui.toast(`Compact non riuscito: ${err instanceof Error ? err.message : String(err)}`)
            }
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
