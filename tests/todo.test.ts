import { test, expect, mock } from 'claude-code/testing'

// Sat 3 Oct 2026, 10:00
const NOW = new Date(2026, 9, 3, 10).getTime()

const cmd = ($: any) => async (args: string) =>
  (await $.command.run({ command: 'todo', args } as any))?.text as string

test('quick add parses date, time, priority, project and labels', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const run = cmd($)

  expect(await run('Pay rent tomorrow p1 #Home @bills')).toContain('p1 Pay rent | due 2026-10-04 | #Home @bills')
  expect(await run('Call mum mon')).toContain('due 2026-10-05')
  expect(await run('Water plants every week')).toContain('repeats week')
  expect(await run('Compra il latte domani')).toContain('due 2026-10-04')
  expect(await run('Review in 3 days')).toContain('due 2026-10-06')
  expect(await run('Standup tomorrow at 9:30')).toContain('due 2026-10-04 09:30')
  expect(await run('Dentista alle 15:00')).toContain('due 2026-10-03 15:00')
  expect(await run('Lunch 1pm')).toContain('due 2026-10-03 13:00')
  expect(await run('list today')).toContain('Water plants')
})

test('completing a recurring task moves its date, others close', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const run = cmd($)

  await run('Weekly review every week')
  expect(await run('done 1')).toContain('next: 2026-10-10')
  await run('One-off')
  expect(await run('done 2')).toContain('Completed')
  expect(await run('rm 2')).toContain('Deleted')
  expect(await run('rm 9')).toContain('No task')
})

test('edit rewrites a task from a quick-add line', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const run = cmd($)

  await run('Draft report tomorrow p3 #Work @deep')
  expect(await run('edit 1 Draft the report p1 mon at 08:15 @deep @urgent')).toContain(
    'p1 Draft the report | due 2026-10-05 08:15 | #Work @deep @urgent',
  )
  expect(await run('edit 1 Draft the report')).toContain('p4 Draft the report | #Work')
  expect(await run('edit 7 nope')).toContain('No task')
})

test('a known verb with bad arguments gives usage and adds nothing', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const run = cmd($)

  expect(await run('done')).toContain('Usage')
  expect(await run('rm abc')).toContain('Usage')
  expect(await run('edit 3')).toContain('Usage')
  expect(await run('move 1 sideways')).toContain('Usage')
  expect(await run('list')).toContain('No tasks')
})

test('run here hands the task to this session as a prompt', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const sent: string[] = []
  on('prompt.submit' as any, async (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({
    plugin: 'todo-list',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'todo-list',
    props: {},
    viewport: { columns: 80, rows: 24 },
  } as any)
  await ui.input({ key: 'new', text: 'Scrivere la bozza tomorrow p1 #Work @tesi' })
  await ui.press({ key: 'view-p:Work' })
  await ui.press({ key: 'sel-1' })
  await ui.press({ key: 'run-1' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Scrivere la bozza')
  expect(sent[0]).toContain('Project: Work, due 2026-10-04, priority p1')
  expect(sent[0]).toContain('todo_complete')
  await ui.unmount()
})

test('new session opens Terminal with the task prompt in a temp file', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const wrote: Record<string, string> = {}
  const ran: string[][] = []
  on('session.cwd' as any, async () => ({ value: "/Users/me/it's here" }))
  on('fs.write' as any, async (_$: any, e: any) => {
    wrote[e.path] = e.text
    return { value: undefined }
  })
  on('process.run' as any, async (_$: any, e: any) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const ui = await $.ui.mount({
    plugin: 'todo-list',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'todo-list',
    props: {},
    viewport: { columns: 80, rows: 24 },
  } as any)
  await ui.input({ key: 'new', text: 'Scrivere la bozza "v2" #Work' })
  await ui.press({ key: 'view-p:Work' })
  await ui.press({ key: 'sel-1' })
  await ui.press({ key: 'new-1' })
  const files = Object.keys(wrote)
  expect(files.length).toBe(1)
  expect(wrote[files[0] as string]).toContain('Scrivere la bozza "v2"')
  expect(wrote[files[0] as string]).not.toContain('todo_complete')
  const argv = ran[0] as string[]
  expect(argv[0]).toBe('osascript')
  const script = argv.join('\n')
  expect(script).toContain('claude \\"$P\\"')
  expect(script).not.toContain('Scrivere')
  expect(script).toContain("it'\\\\''s here")
  await ui.unmount()
})

test('move reorders tasks inside a project', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const run = cmd($)

  await run('One #P')
  await run('Two #P')
  await run('Three #P')
  const order = async () => ((await run('list P')) as string).split('\n').slice(1).map(l => l.split(' ')[4])
  expect(await order()).toEqual(['One', 'Two', 'Three'])
  await run('move 3 up')
  expect(await order()).toEqual(['One', 'Three', 'Two'])
  await run('move 2 top')
  expect(await order()).toEqual(['Two', 'One', 'Three'])
  expect(await run('move 2 up')).toContain('stays')
})

test('a reminder fires at the task minute', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast' as any, async (_$: any, e: any) => {
    toasts.push(e.text)
  })
  on('session.start' as any, async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register' as any, async () => ({ value: { command: 'todo' } }))
  on('tool.register' as any, async () => ({ value: { tool: 'x' } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await cmd($)('Standup at 10:02')
  await clock.advance(3 * 60000)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Standup')
  await clock.advance(5 * 60000)
  expect(toasts.length).toBe(1)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane on ${surface}: add, project, select, edit, complete, delete`, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    const ui = await $.ui.mount({
      plugin: 'todo-list',
      surface,
      component: 'Pane',
      requestId: 'todo-list',
      props: {},
      viewport: { columns: 80, rows: 24 },
    } as any)

    await ui.input({ key: 'new', text: 'comprare il latte p2' })
    expect(await ui.find({ key: 'tog-1' })).toBeDefined()
    await ui.input({ key: 'new', text: 'Report tomorrow at 14:30 #Work' })
    await ui.press({ key: 'view-p:Work' })
    expect(await ui.find({ key: 'tog-2' })).toBeDefined()
    expect(await ui.find({ key: 'tog-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Tomorrow 14:30/ })).toBeDefined()

    // edit through the selected row
    await ui.press({ key: 'sel-2' })
    await ui.press({ key: 'edit-2' })
    await ui.input({ key: 'edit', text: 'Report final p1 tomorrow at 16:00 #Work' })
    expect(await ui.find({ type: 'Text', text: /Tomorrow 16:00/ })).toBeDefined()

    await ui.press({ key: 'tog-2' })
    expect(await ui.find({ key: 'tog-2' })).toBeUndefined()
    await ui.press({ key: 'toggle-done' })
    expect((await ui.find({ key: 'tog-2' }))?.text).toContain('●')
    await ui.press({ key: 'del-2' })
    expect(await ui.find({ key: 'tog-2' })).toBeUndefined()
    await ui.unmount()
  })
}
