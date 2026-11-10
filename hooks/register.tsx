// change-desk: band, pane, undo per prompt
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Meter } from '../types'

const PANE = 'change-desk'
const changes = atom({ plugin: 'change-desk', key: 'changes' } as const, [], {
  shape: 'changes-4',
})
const meter = atom({ plugin: 'change-desk', key: 'meter' } as const, null, {
  shape: 'meter-5',
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

// After a compaction the session still reports the last response's context
// fill, from before it. Until a new response arrives (the reported tokens
// change) the mod shows the size the compaction left instead.
let compacted: { staleTokens: number | undefined; tokens: number } | null = null

// `figures` is a measurement's own input when the caller has one; otherwise
// the session is asked.
const refresh = async ($: any, figures?: any) => {
  const mine = ++latestRefresh
  const u = figures ?? (await $.session.usage())
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
  }
  if (compacted !== null) {
    if (u.context?.tokens === compacted.staleTokens && m.window > 0) {
      m.tokens = compacted.tokens
      m.percent = Math.min(100, Math.round((compacted.tokens / m.window) * 100))
    } else {
      compacted = null
    }
  }
  if (mine !== latestRefresh) return
  await update($, meter, () => m)
}

// Lines added and removed by one Edit or Write, read from the diff Claude Code
// itself recorded for the call (`structuredPatch`).
const patchStats = (patch: unknown) => {
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(patch) ? patch : []) {
    for (const line of (hunk?.lines ?? []) as string[]) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// The file as it was before a call, as Claude Code recorded it. `undefined`:
// the file existed but its content was too large for Claude Code to record.
const recordedBefore = (tool: string, result: any): string | null | undefined => {
  if (typeof result?.originalFile === 'string') return result.originalFile
  if (tool === 'Write') return result?.type === 'create' ? null : undefined
  return result?.oldString === '' ? null : undefined
}

// A file the mod (or anyone) put back as it was is no longer changed: told
// from the file on disk, compared with Claude Code's record of the original.
const isReverted = async ($: any, c: Change) => {
  if (c.isBeforeLost) return false
  const exists = await $.fs.exists(c.path)
  if (c.before === null) return !exists
  return exists && ((await $.fs.read(c.path)) as string) === c.before
}

// Builds the list from the session's transcript, the Edit and Write calls
// Claude Code recorded, when the mod holds none (a session opened again).
// The transcript keeps no time per call: those rows show none.
const rebuild = async ($: any) => {
  if ((await read($, changes)).length > 0) return
  const rows = (await $.session.messages()) as any[]
  const out: Change[] = []
  let turn = 0
  let prompt = ''
  for (const row of rows) {
    if (row.role === 'user') {
      if (row.text !== '' && !(row.toolResults?.length > 0)) {
        turn++
        prompt = row.text
      }
      continue
    }
    for (const use of row.toolUses ?? []) {
      if (use.tool !== 'Edit' && use.tool !== 'Write') continue
      const r = use.result as any
      if (use.isError || r === undefined || r === null || r.staged === true) continue
      const path: string = r.filePath ?? (use.input?.file_path as string)
      const stats = patchStats(r.structuredPatch)
      const first = out.find(c => c.path === path)
      const same = out.find(c => c.path === path && c.turn === turn)
      if (same) {
        same.edits++
      } else {
        const before = first ? first.before : recordedBefore(use.tool, r)
        out.push({
          path,
          tool: use.tool,
          before: before ?? null,
          isBeforeLost: first ? first.isBeforeLost : before === undefined,
          edits: 1,
          isUndone: false,
          turn,
          prompt,
          at: 0,
          added: 0,
          removed: 0,
        })
      }
      // every entry of the path carries the file's running total
      for (const c of out) {
        if (c.path === path) {
          c.added = (first?.added ?? 0) + stats.added
          c.removed = (first?.removed ?? 0) + stats.removed
        }
      }
    }
  }
  if (out.length === 0) return
  const reverted = new Set<string>()
  for (const path of new Set(out.map(c => c.path))) {
    const original = out.find(c => c.path === path) as Change
    if (await isReverted($, original)) reverted.add(path)
  }
  await update($, changes, () => out.map(c => (reverted.has(c.path) ? { ...c, isUndone: true } : c)))
  await update($, turnNo, n => Math.max(n, turn))
}

// Riporta i file a com'erano prima delle voci date. Dal prompt più recente al
// più vecchio, così per un file toccato più volte vince lo stato più antico.
const undoEntries = async ($: any, entries: Change[]) => {
  const ordered = [...entries].filter(c => !c.isBeforeLost).sort((a, b) => b.turn - a.turn)
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
    // Older versions kept the last limits here: the mod now shows only live ones.
    await $.store.delete('limits').catch(() => undefined)
    await rebuild($).catch(() => undefined)
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
      const ran = await next(e)
      // Only what Claude Code recorded as done: no error, not held for review.
      const r = (ran as any).result
      if ('deny' in ran || ran.isError || r === undefined || r === null || r.staged === true) return ran
      const tool = e.tool
      const path: string = r.filePath ?? e.file_path
      const turn = await read($, turnNo)
      const prompt = await read($, lastPrompt)
      const stats = patchStats(r.structuredPatch)
      const at = await $.clock.now()
      const live = (await read($, changes)).filter(c => c.path === path && !c.isUndone)
      const first = [...live].sort((x, y) => x.turn - y.turn)[0]
      const added = (first?.added ?? 0) + stats.added
      const removed = (first?.removed ?? 0) + stats.removed
      if (live.some(c => c.turn === turn)) {
        await update($, changes, l =>
          l.map(c =>
            c.path === path && !c.isUndone
              ? { ...c, added, removed, ...(c.turn === turn ? { edits: c.edits + 1, at } : {}) }
              : c,
          ),
        )
      } else {
        const before = first ? first.before : recordedBefore(tool, r)
        const c: Change = {
          path,
          tool,
          before: before ?? null,
          isBeforeLost: first ? first.isBeforeLost : before === undefined,
          edits: 1,
          isUndone: false,
          turn,
          prompt,
          at,
          added,
          removed,
        }
        await update($, changes, l => [
          ...l.map(o => (o.path === path && !o.isUndone ? { ...o, added, removed } : o)),
          c,
        ].slice(-200))
      }
      await refresh($)
      return ran
    })
  }

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const before = await $.session.usage()
    const done = await next(e)
    if (done.skip === undefined) {
      let after = done.tokensAfter
      if (after === undefined) {
        const est = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
        after = est?.context.breakdown?.totalTokens
      }
      if (after !== undefined) {
        compacted = { staleTokens: before.context.tokens, tokens: after }
        await refresh($).catch(() => undefined)
      }
    }
    return done
  })

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
              meterRow(l.kind, LABELS[l.kind] ?? l.kind, l.percent, resetIn(now, l.resetsAt)),
            )}
          {(m === null || m.limits.length === 0) &&
            meterRow('lim', 'Limiti', null, 'dopo la prima risposta')}
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
            const isNew = mine[0]?.before === null && mine[0]?.isBeforeLost !== true
            const canUndo = mine.some(c => !c.isBeforeLost)
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
                    <Text dimColor>{latest === undefined || latest.at === 0 ? '' : ago(now, latest.at)}</Text>
                  </Box>
                )}
                <Box width={buttonCols} flexShrink={0} justifyContent="flex-end">
                  {canUndo ? (
                    <Button key={`u-${path}`} variant="secondary" onPress={() => undoEntries($, mine)}>
                      <Text>{isWide ? '↺ Annulla' : '↺'}</Text>
                    </Button>
                  ) : (
                    <Text dimColor>{isWide ? 'non annull.' : '–'}</Text>
                  )}
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
                  <Text color={alert(l.percent)} dimColor={l.percent < 60} bold={l.percent >= 60}>
                    {l.percent}%
                  </Text>
                </Text>
              ))}
              {limits.length === 0 && (
                <Text>
                  {dot()}
                  <Text dimColor>5h —</Text>
                </Text>
              )}
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
            // Run as if typed: the engine queues /compact and runs it once the
            // session is idle, instead of refusing while a turn runs.
            try {
              await $.command.run({ command: 'compact' })
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
