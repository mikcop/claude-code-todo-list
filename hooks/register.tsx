import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'

const PANE = 'todo-list'
const items = atom({ plugin: 'todo-list', key: 'items' } as const, [])
const projects = atom({ plugin: 'todo-list', key: 'projects' } as const, [])
const selected = atom({ plugin: 'todo-list', key: 'selected' } as const, 0)
const editing = atom({ plugin: 'todo-list', key: 'editing' } as const, 0)
const view = atom({ plugin: 'todo-list', key: 'view' } as const, 'inbox')
const draft = atom({ plugin: 'todo-list', key: 'draft' } as const, '')
const parent = atom({ plugin: 'todo-list', key: 'parent' } as const, 0)
const showDone = atom({ plugin: 'todo-list', key: 'showDone' } as const, false)

// reminders already shown this load
const fired = new Set<string>()

const PRI_COLOR: Record<number, string> = { 1: 'red', 2: 'yellow', 3: 'blue' }
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW: Record<string, number> = {
  mon: 1, lun: 1, tue: 2, mar: 2, wed: 3, mer: 3, thu: 4, gio: 4,
  fri: 5, ven: 5, sat: 6, sab: 6, sun: 0, dom: 0,
}
const DAY =
  'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|' +
  'lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sab(?:ato)?|dom(?:enica)?'

// ---------- dates (pure) ----------

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function fromYmd(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y as number, (m as number) - 1, d as number, 12)
}

function addDays(s: string, n: number) {
  const d = fromYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

function nextDow(from: string, dow: number, inclusive: boolean) {
  let diff = (dow - fromYmd(from).getDay() + 7) % 7
  if (diff === 0 && !inclusive) diff = 7
  return addDays(from, diff)
}

function nextWeekday(from: string, inclusive: boolean) {
  let s = inclusive ? from : addDays(from, 1)
  while ([0, 6].includes(fromYmd(s).getDay())) s = addDays(s, 1)
  return s
}

// a real calendar day: no 31/02, no month 13
function isDate(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  const x = new Date(y as number, (m as number) - 1, d as number, 12)
  return x.getFullYear() === y && x.getMonth() === (m as number) - 1 && x.getDate() === d
}

// the same day next month, or its last day when the month is shorter (31 Jan -> 28 Feb)
function addMonth(s: string) {
  const d = fromYmd(s)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
  return ymd(d)
}

function nextOnce(due: string, recur: string) {
  if (recur === 'day') return addDays(due, 1)
  if (recur === 'week') return addDays(due, 7)
  if (recur === 'weekday') return nextWeekday(due, false)
  if (recur.startsWith('dow:')) return nextDow(due, Number(recur.slice(4)), false)
  return addMonth(due)
}

// the next occurrence after today: an overdue recurring task skips the dates it missed
function nextDue(due: string, recur: string, today: string) {
  let s = nextOnce(due, recur)
  while (s <= today) s = nextOnce(s, recur)
  return s
}

function dueDay(due: string, today: string) {
  if (due === today) return 'Today'
  if (due === addDays(today, 1)) return 'Tomorrow'
  const d = fromYmd(due)
  const ahead = Math.round((d.getTime() - fromYmd(today).getTime()) / 86400000)
  if (ahead > 1 && ahead < 7) return DN[d.getDay()] as string
  return `${DN[d.getDay()]} ${d.getDate()} ${MN[d.getMonth()]}`
}

const dueLabel = (due: string, today: string, time: string) =>
  dueDay(due, today) + (time ? ` ${time}` : '')

const isLate = (t: Task, today: string, hm: string) =>
  !t.isDone && t.due !== '' && (t.due < today || (t.due === today && t.time !== '' && t.time < hm))

function recurText(recur: string) {
  if (recur.startsWith('dow:')) return `every ${(DN[Number(recur.slice(4))] as string).toLowerCase()}`
  return `every ${recur}`
}

// a task as the quick-add line that would recreate it: what the edit field shows
function toQuick(t: Task) {
  return [
    t.text,
    t.priority < 4 ? `p${t.priority}` : '',
    t.recur ? recurText(t.recur) : '',
    t.due,
    t.time ? `at ${t.time}` : '',
    t.project !== 'Inbox' ? `#${t.project.replace(/ /g, '_')}` : '',
    ...t.labels.map(l => `@${l}`),
  ]
    .filter(Boolean)
    .join(' ')
}

// ---------- quick add (pure) ----------

// a day/month date in the line (20/10, 20/10/27) as [ymd], or null when there is none or it is not a real day
function dayMonth(s: string, today: string): [string] | null {
  const m = s.match(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/)
  if (!m) return null
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : fromYmd(today).getFullYear()
  const at = (yy: number) => `${yy}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`
  let due = at(y)
  if (!m[3] && due < today) due = at(y + 1)
  return isDate(due) ? [due] : null
}

function parseQuick(input: string, today: string) {
  let s = ` ${input} `
  const take = (re: RegExp) => {
    const m = s.match(re)
    if (m) s = s.replace(re, ' ')
    return m
  }

  let priority: 1 | 2 | 3 | 4 = 4
  const pm = take(/\sp([1-4])(?=\s)/i)
  if (pm) priority = Number(pm[1]) as 1 | 2 | 3 | 4

  let project = ''
  const hm = take(/\s#(\S+)(?=\s)/)
  if (hm) project = (hm[1] as string).replace(/_/g, ' ')

  const labels: string[] = []
  for (let m = take(/\s@(\S+)(?=\s)/); m; m = take(/\s@(\S+)(?=\s)/)) labels.push(m[1] as string)

  let time = ''
  const timeRes: [RegExp, number, number, number][] = [
    [/\s(?:at|alle|ore)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?=\s)/i, 1, 2, 3],
    [/\s(\d{1,2}):(\d{2})\s*(am|pm)?(?=\s)/i, 1, 2, 3],
    [/\s(\d{1,2})\s*(am|pm)(?=\s)/i, 1, 0, 2],
  ]
  for (const [re, hi, mi, ai] of timeRes) {
    const m = s.match(re)
    if (!m) continue
    let h = Number(m[hi])
    const mm = mi ? Number(m[mi] ?? 0) : 0
    const ap = (m[ai] ?? '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h > 23 || mm > 59) continue
    time = `${pad(h)}:${pad(mm)}`
    s = s.replace(re, ' ')
    break
  }

  let due = ''
  let recur = ''
  const rm = take(
    new RegExp(
      `\\s(?:every|ogni)\\s+(?:(giorno feriale|weekdays?|day|giorno|week|settimana|month|mese)|(${DAY}))(?=\\s)`,
      'i',
    ),
  )
  if (rm) {
    if (rm[2]) {
      const dow = DOW[rm[2].slice(0, 3).toLowerCase()] as number
      recur = `dow:${dow}`
      due = nextDow(today, dow, true)
    } else {
      const k = (rm[1] as string).toLowerCase()
      recur = /feriale|weekday/.test(k) ? 'weekday' : /week|settimana/.test(k) ? 'week' : /month|mese/.test(k) ? 'month' : 'day'
      due = recur === 'weekday' ? nextWeekday(today, true) : today
    }
  }
  {
    let m: RegExpMatchArray | null
    let dm: [string] | null
    if (take(/\s(?:today|oggi)(?=\s)/i)) due = today
    else if (take(/\sdopodomani(?=\s)/i)) due = addDays(today, 2)
    else if (take(/\s(?:tomorrow|domani)(?=\s)/i)) due = addDays(today, 1)
    else if (take(/\s(?:next week|prossima settimana)(?=\s)/i)) due = nextDow(today, 1, false)
    else if ((m = take(/\sin\s+(\d+)\s+(days?|giorni|giorno|weeks?|settimane|settimana)(?=\s)/i)))
      due = addDays(today, Number(m[1]) * (/^(w|s)/i.test(m[2] as string) ? 7 : 1))
    else if ((m = s.match(/\s(\d{4}-\d{2}-\d{2})(?=\s)/)) && isDate(m[1] as string)) {
      take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/)
      due = m[1] as string
    } else if ((dm = dayMonth(s, today))) {
      take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/)
      due = dm[0]
    } else if ((m = take(new RegExp(`\\s(${DAY})(?=\\s)`, 'i'))))
      due = nextDow(today, DOW[(m[1] as string).slice(0, 3).toLowerCase()] as number, false)
  }

  if (time && !due) due = today

  return { text: s.replace(/\s+/g, ' ').trim(), priority, project, labels, due, time, recur }
}

// ---------- views (pure) ----------

type Ctx = { today: string; hm: string }
const isFlatView = (w: string) => w === 'today' || w === 'upcoming'

// the rows of a view: inbox/project keep the manual order, today/upcoming sort by date, time, priority
function select(list: Task[], which: string, c: Ctx, withDone: boolean) {
  const w = which.toLowerCase()
  let out: Task[]
  if (w === 'inbox') out = list.filter(t => t.project === 'Inbox')
  else if (w === 'today') out = list.filter(t => !t.isDone && t.due !== '' && t.due <= c.today)
  else if (w === 'upcoming') out = list.filter(t => !t.isDone && t.due !== '')
  else if (w === '' || w === 'all') out = list
  else {
    const name = w.startsWith('p:') ? w.slice(2) : w
    out = list.filter(t => t.project.toLowerCase() === name)
  }
  if (!withDone || w === 'today' || w === 'upcoming') out = out.filter(t => !t.isDone)
  if (!isFlatView(w)) return out
  return [...out].sort(
    (a, b) =>
      (a.due || '9999').localeCompare(b.due || '9999') ||
      (a.time || '99:99').localeCompare(b.time || '99:99') ||
      a.priority - b.priority,
  )
}

// a name a person or the model typed -> a view id
function resolveView(which: string, projs: string[]) {
  const w = which.trim()
  const lw = w.toLowerCase()
  if (['', 'all', 'inbox', 'today', 'upcoming'].includes(lw)) return lw || 'all'
  if (lw.startsWith('p:')) return w
  return `p:${projs.find(x => x.toLowerCase() === lw) ?? w}`
}

function descendants(list: Task[], id: number): number[] {
  const kids = list.filter(t => t.parent === id).map(t => t.id)
  return [...kids, ...kids.flatMap(k => descendants(list, k))]
}

function norm(t: any): Task {
  return {
    id: Number(t.id),
    text: String(t.text ?? ''),
    isDone: !!t.isDone,
    priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 4,
    project: String(t.project ?? 'Inbox'),
    labels: Array.isArray(t.labels) ? t.labels.map(String) : [],
    due: String(t.due ?? ''),
    time: String(t.time ?? ''),
    recur: String(t.recur ?? ''),
    parent: Number(t.parent ?? 0),
  }
}

function line(t: Task) {
  return (
    `${t.id} [${t.isDone ? 'x' : ' '}] p${t.priority} ${t.text}` +
    (t.due ? ` | due ${t.due}${t.time ? ` ${t.time}` : ''}` : '') +
    (t.recur ? ` | repeats ${t.recur}` : '') +
    ` | #${t.project}` +
    t.labels.map(l => ` @${l}`).join('') +
    (t.parent ? ` | subtask of ${t.parent}` : '')
  )
}

// ---------- operations (take $) ----------

async function todayStr($: any) {
  return ymd(new Date(await $.clock.now()))
}

async function nowCtx($: any): Promise<Ctx> {
  const d = new Date(await $.clock.now())
  return { today: ymd(d), hm: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

async function showStatus($: any, list: Task[]) {
  const c = await nowCtx($)
  const n = list.filter(t => !t.isDone && t.due !== '' && t.due <= c.today).length
  $.ui.status(n === 0 ? undefined : `todo ${n} today`)
}

// takes in what other sessions saved since this one last looked, so a change here does not undo theirs
async function sync($: any) {
  const stored = await $.store.get('items')
  if (Array.isArray(stored)) {
    const next = stored.map(norm)
    if (JSON.stringify(next) !== JSON.stringify(await read($, items))) await update($, items, () => next)
  }
  const storedProjects = await $.store.get('projects')
  if (Array.isArray(storedProjects)) {
    const next = storedProjects.map(String)
    if (JSON.stringify(next) !== JSON.stringify(await read($, projects))) await update($, projects, () => next)
  }
}

async function save($: any, next: Task[]) {
  await update($, items, () => next)
  await $.store.set('items', next)
  await showStatus($, next)
}

async function saveProjects($: any, next: string[]) {
  await update($, projects, () => next)
  await $.store.set('projects', next)
}

async function addTask(
  $: any,
  input: string,
  ctx: { project?: string; due?: string; parent?: number },
): Promise<Task | null> {
  await sync($)
  const today = await todayStr($)
  const p = parseQuick(input, today)
  if (!p.text) return null
  const list = await read($, items)
  const projs = await read($, projects)
  const par = ctx.parent ? list.find(t => t.id === ctx.parent) : undefined

  let project = p.project || ctx.project || 'Inbox'
  if (par) project = par.project
  const known = ['Inbox', ...projs].find(x => x.toLowerCase() === project.toLowerCase())
  if (known) project = known
  else await saveProjects($, [...projs, project])

  const task: Task = {
    id: list.reduce((m: number, t: Task) => Math.max(m, t.id), 0) + 1,
    text: p.text,
    isDone: false,
    priority: p.priority,
    project,
    labels: p.labels,
    due: p.due || ctx.due || '',
    time: p.time,
    recur: p.recur,
    parent: par ? par.id : 0,
  }
  await save($, [...list, task])
  return task
}

async function addFromPane($: any, input: string) {
  const v = await read($, view)
  const today = await todayStr($)
  const ctx = {
    project: v.startsWith('p:') ? v.slice(2) : undefined,
    due: v === 'today' ? today : undefined,
    parent: await read($, parent),
  }
  await addTask($, input, ctx)
  await update($, parent, () => 0)
}

async function completeTask($: any, id: number): Promise<string> {
  await sync($)
  const list = await read($, items)
  const t = list.find((x: Task) => x.id === id)
  if (!t) return `No task ${id}`
  if (!t.isDone && t.recur && t.due) {
    const due = nextDue(t.due, t.recur, await todayStr($))
    await save($, list.map((x: Task) => (x.id === id ? { ...x, due } : x)))
    return `Done: ${t.text} (next: ${due})`
  }
  const ids = new Set([id, ...(t.isDone ? [] : descendants(list, id))])
  await save($, list.map((x: Task) => (ids.has(x.id) ? { ...x, isDone: !t.isDone } : x)))
  return `${t.isDone ? 'Reopened' : 'Completed'}: ${t.text}`
}

async function deleteTask($: any, id: number): Promise<string> {
  await sync($)
  const list = await read($, items)
  const t = list.find((x: Task) => x.id === id)
  if (!t) return `No task ${id}`
  const gone = new Set([id, ...descendants(list, id)])
  await update($, selected, (s: number) => (gone.has(s) ? 0 : s))
  await update($, parent, (s: number) => (gone.has(s) ? 0 : s))
  if (gone.has(await read($, editing))) await cancelInput($)
  await save($, list.filter((x: Task) => !gone.has(x.id)))
  return `Deleted: ${t.text}`
}

async function cyclePriority($: any, id: number) {
  await sync($)
  const list = await read($, items)
  await save(
    $,
    list.map((x: Task) => (x.id === id ? { ...x, priority: (x.priority === 1 ? 4 : x.priority - 1) as Task['priority'] } : x)),
  )
}

async function deleteProject($: any, name: string) {
  await sync($)
  const list = await read($, items)
  await save($, list.map((x: Task) => (x.project === name ? { ...x, project: 'Inbox' } : x)))
  await saveProjects($, (await read($, projects)).filter((p: string) => p !== name))
  await update($, view, () => 'inbox')
}

async function listText($: any, which: string) {
  await sync($)
  const c = await nowCtx($)
  const id = resolveView(which, await read($, projects))
  try {
    const rows = select(await read($, items), id, c, false)
    return `Now: ${c.today} ${c.hm}.\n` + (rows.length ? rows.map(line).join('\n') : 'No tasks.')
  } catch (err) {
    return String((err as Error).message)
  }
}

async function updateTask($: any, id: number, input: string): Promise<string> {
  await sync($)
  const c = await nowCtx($)
  const p = parseQuick(input, c.today)
  const list = await read($, items)
  const t = list.find((x: Task) => x.id === id)
  if (!t) return `No task ${id}`
  if (!p.text) return 'Nothing to change.'
  let project = t.project
  if (p.project) {
    const projs = await read($, projects)
    const known = ['Inbox', ...projs].find(x => x.toLowerCase() === p.project.toLowerCase())
    project = known ?? p.project
    if (!known) await saveProjects($, [...projs, project])
  }
  const next: Task = { ...t, text: p.text, priority: p.priority, labels: p.labels, due: p.due, time: p.time, recur: p.recur, project }
  // subtasks follow their task to its new project
  const kids = new Set(descendants(list, id))
  await save($, list.map((x: Task) => (x.id === id ? next : kids.has(x.id) ? { ...x, project } : x)))
  return `Updated: ${line(next)}`
}

async function moveTask($: any, id: number, dir: string): Promise<string> {
  await sync($)
  const list = await read($, items)
  const idx = list.findIndex((x: Task) => x.id === id)
  if (idx < 0) return `No task ${id}`
  const t = list[idx] as Task
  const sib = list
    .map((x: Task, i: number) => (x.parent === t.parent && x.project === t.project && x.isDone === t.isDone ? i : -1))
    .filter((i: number) => i >= 0)
  const pos = sib.indexOf(idx)
  const to = dir === 'up' ? pos - 1 : dir === 'down' ? pos + 1 : dir === 'top' ? 0 : -1
  if (to < 0 || to >= sib.length || to === pos) return `Task ${id} stays where it is.`
  const next = [...list]
  if (dir === 'top') {
    next.splice(idx, 1)
    next.splice(sib[0] as number, 0, t)
  } else {
    next[idx] = list[sib[to] as number] as Task
    next[sib[to] as number] = t
  }
  await save($, next)
  return `Moved ${dir}: ${t.text}`
}

async function startEdit($: any, id: number) {
  const t = (await read($, items)).find((x: Task) => x.id === id)
  if (!t) return
  await update($, editing, () => id)
  await update($, draft, () => toQuick(t))
}

async function cancelInput($: any) {
  await update($, editing, () => 0)
  await update($, parent, () => 0)
  await update($, draft, () => '')
}

async function submitInput($: any, input: string) {
  const ed = await read($, editing)
  if (ed) await updateTask($, ed, input)
  else await addFromPane($, input)
  await cancelInput($)
}

// the prompt that asks Claude to carry a task out, with what the list knows about it
function taskPrompt(list: Task[], t: Task, canComplete: boolean) {
  const subs = descendants(list, t.id)
    .map(id => list.find(x => x.id === id))
    .filter((x): x is Task => !!x && !x.isDone)
  return [
    `Work on this task from my to-do list (id ${t.id}): ${t.text}`,
    `Project: ${t.project}` +
      (t.due ? `, due ${t.due}${t.time ? ` ${t.time}` : ''}` : '') +
      (t.priority < 4 ? `, priority p${t.priority}` : '') +
      (t.labels.length ? `, labels ${t.labels.map(l => `@${l}`).join(' ')}` : ''),
    subs.length ? `Subtasks:\n${subs.map(x => `- ${x.text}`).join('\n')}` : '',
    canComplete ? 'When it is done, mark it complete with the todo_complete tool.' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// hands a task to the session that is open now: a turn of its own once the session is idle
async function runHere($: any, id: number) {
  const list = await read($, items)
  const t = list.find((x: Task) => x.id === id)
  if (!t || t.isDone) return
  void $.prompt.submit({ text: taskPrompt(list, t, true), asUser: true })
  $.ui.toast(`Sent to this session: ${t.text}`)
}

const shq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
const asq = (x: string) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// opens a Terminal window with an interactive claude started on the task: a session of its own.
// The prompt goes through a temp file, so no task text ever reaches a shell or AppleScript string.
async function runInNewSession($: any, id: number) {
  const list = await read($, items)
  const t = list.find((x: Task) => x.id === id)
  if (!t || t.isDone) return
  const file = `/tmp/todo-list-task-${t.id}-${await $.clock.now()}.txt`
  const cwd = await $.session.cwd()
  await $.fs.write(file, taskPrompt(list, t, false))
  const shell = `cd ${shq(cwd)} && P="$(cat ${shq(file)})" && rm -f ${shq(file)} && claude "$P"`
  const run = await $.process.run([
    'osascript',
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script "${asq(shell)}"`,
    '-e', 'end tell',
  ])
  $.ui.toast(
    run.exitCode === 0
      ? `Opened a new session for: ${t.text}`
      : `Could not open Terminal: ${String(run.stderr).trim().slice(0, 120)}`,
  )
}

// a reminder for each timed task whose minute has come
async function remind($: any) {
  const c = await nowCtx($)
  for (const t of await read($, items)) {
    const key = `${t.id}:${t.due}:${t.time}`
    if (t.isDone || t.due !== c.today || t.time !== c.hm || fired.has(key)) continue
    fired.add(key)
    $.ui.toast(`${t.time}  ${t.text}`, { timeoutMs: 15000 })
  }
}

// ---------- the mod ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description:
        'Tasks: /todo [<quick add> | done <id> | rm <id> | edit <id> <text> | move <id> up|down|top | list [view] | project <name> | clear]',
    })
    await $.tool.register({
      name: 'todo_list',
      description:
        "List the user's tasks with ids. view: inbox | today | upcoming | all (default) | a project name.",
      inputSchema: { type: 'object', properties: { view: { type: 'string' } } },
    })
    await $.tool.register({
      name: 'todo_add',
      description:
        "Add a task. Quick-add syntax: 'Pay rent tomorrow at 9:30 p1 #Home @bills' (p1-p4 priority, #project, @label, " +
        "dates like today/tomorrow/mon/in 3 days/2026-10-20/20/10, times like 'at 14:30' or '3pm', recurrence like 'every week').",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, parent: { type: 'number', description: 'id of the parent task' } },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'todo_update',
      description:
        "Rewrite a task from a full quick-add line (same syntax as todo_add): text, priority, date, time, recurrence and labels are " +
        "replaced by what the line says; the project stays unless the line has #project.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    })
    await $.tool.register({
      name: 'todo_complete',
      description: 'Complete a task by id (a recurring task moves to its next date; a done task is reopened).',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'todo_delete',
      description: 'Delete a task and its subtasks by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    })

    const stored = (await $.store.get('items')) as unknown[] | undefined
    const storedProjects = (await $.store.get('projects')) as string[] | undefined
    await saveProjects($, Array.isArray(storedProjects) ? storedProjects : [])
    await $.store.delete('filters')
    await save($, Array.isArray(stored) ? stored.map(norm) : [])
    // every 20s: pick up other sessions' changes, keep the status line on today's date, fire reminders
    $.clock.every(20000, async () => {
      await sync($)
      await showStatus($, await read($, items))
      await remind($)
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__todo-list__todo_list' }, async ($, e) => ({
    result: await listText($, String((e as any).view ?? 'all')),
  }))

  on('tool.call', { tool: 'mcp__todo-list__todo_add' }, async ($, e) => {
    const t = await addTask($, String((e as any).text ?? ''), { parent: Number((e as any).parent ?? 0) })
    return { result: t ? `Added: ${line(t)}` : 'Nothing to add.' }
  })

  on('tool.call', { tool: 'mcp__todo-list__todo_update' }, async ($, e) => ({
    result: await updateTask($, Number((e as any).id), String((e as any).text ?? '')),
  }))

  on('tool.call', { tool: 'mcp__todo-list__todo_complete' }, async ($, e) => ({
    result: await completeTask($, Number((e as any).id)),
  }))

  on('tool.call', { tool: 'mcp__todo-list__todo_delete' }, async ($, e) => ({
    result: await deleteTask($, Number((e as any).id)),
  }))

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = '', ...rest] = args.split(/\s+/)
    const arg = rest.join(' ')

    if (verb === '') {
      await $.ui.open({ id: PANE, title: 'To-do' })
      return { text: 'To-do pane opened.' }
    }
    // a known verb with the wrong arguments says how to use it, instead of becoming a task
    const usage: Record<string, string> = {
      done: '/todo done <id>',
      rm: '/todo rm <id>',
      edit: '/todo edit <id> <new text>',
      move: '/todo move <id> up|down|top',
      project: '/todo project <name>',
    }
    const id = Number(rest[0])
    const isBad =
      (['done', 'rm'].includes(verb) && !(rest.length === 1 && Number.isInteger(id))) ||
      (verb === 'edit' && !(rest.length > 1 && Number.isInteger(id))) ||
      (verb === 'move' && !(rest.length === 2 && Number.isInteger(id) && ['up', 'down', 'top'].includes(rest[1] as string))) ||
      (verb === 'project' && !arg)
    if (isBad) return { text: `Usage: ${usage[verb]}` }

    if (verb === 'list') return { text: await listText($, arg || 'all') }
    if (verb === 'done') return { text: await completeTask($, id) }
    if (verb === 'rm') return { text: await deleteTask($, id) }
    if (verb === 'edit') return { text: await updateTask($, id, rest.slice(1).join(' ')) }
    if (verb === 'move') return { text: await moveTask($, id, rest[1] as string) }
    if (verb === 'project') {
      await sync($)
      const projs = await read($, projects)
      const known = ['Inbox', ...projs].find(x => x.toLowerCase() === arg.toLowerCase())
      if (!known) await saveProjects($, [...projs, arg])
      return { text: `Project ready: ${known ?? arg}` }
    }
    if (verb === 'clear') {
      await sync($)
      const list = await read($, items)
      await save($, list.filter((t: Task) => !t.isDone))
      return { text: 'Cleared completed tasks.' }
    }

    const t = await addTask($, verb === 'add' ? arg : args, {})
    return { text: t ? `Added: ${line(t)}` : 'Nothing to add.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const c = await nowCtx($)
    const { today, hm } = c
    const list = await read($, items)
    const projs = await read($, projects)
    const v = await read($, view)
    const par = await read($, parent)
    const sel = await read($, selected)
    const ed = await read($, editing)
    const withDone = await read($, showDone)
    const text = await read($, draft)

    const count = (w: string) => {
      try {
        return select(list, w, c, false).length
      } catch {
        return 0
      }
    }
    const isProject = v.startsWith('p:')
    const isFlat = isFlatView(v)
    const title =
      v === 'inbox' ? 'Inbox' : v === 'today' ? 'Today' : v === 'upcoming' ? 'Upcoming' : v.slice(2)
    let rows: Task[] = []
    let problem = ''
    try {
      rows = select(list, v, c, withDone)
    } catch (err) {
      problem = String((err as Error).message)
    }
    const roots = isFlat ? rows : rows.filter(t => !t.parent || !rows.some(x => x.id === t.parent))
    const parentTask = list.find((t: Task) => t.id === par)
    const editTask = list.find((t: Task) => t.id === ed)

    const action = (key: string, label: string, run: () => unknown) => (
      <Button key={key} plain dimColor label={label} onPress={run} />
    )

    const row = (t: Task, depth: number): any[] => [
      <Box key={`row-${t.id}`} flexDirection="column" paddingLeft={depth * 2}>
        <Box gap={1} alignItems="flex-start">
          <Button key={`tog-${t.id}`} plain label={t.isDone ? '●' : '○'} onPress={() => completeTask($, t.id)} />
          {t.priority < 4 && <Text bold color={PRI_COLOR[t.priority]}>p{t.priority}</Text>}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap" strikethrough={t.isDone} dimColor={t.isDone}>{t.text}</Text>
          </Box>
          <Button
            key={`sel-${t.id}`}
            plain
            dimColor={sel !== t.id}
            label="⋯"
            onPress={() => update($, selected, (x: number) => (x === t.id ? 0 : t.id))}
          />
        </Box>
        {(!!t.due || t.labels.length > 0 || isFlat) && (
          <Box gap={1} flexWrap="wrap" paddingLeft={2}>
            {!!t.due && (
              <Text color={isLate(t, today, hm) ? 'red' : t.due === today ? 'green' : 'yellow'}>
                {t.recur ? '↻ ' : ''}{dueLabel(t.due, today, t.time)}
              </Text>
            )}
            {t.labels.length > 0 && <Text color="cyan">{t.labels.map(l => `@${l}`).join(' ')}</Text>}
            {isFlat && <Text dimColor>#{t.project}</Text>}
          </Box>
        )}
      </Box>,
      ...(sel === t.id
        ? [
            <Box key={`act-${t.id}`} gap={1} flexWrap="wrap" paddingLeft={depth * 2 + 2}>
              {!t.isDone && action(`run-${t.id}`, '▶ run here', () => runHere($, t.id))}
              {!t.isDone && action(`new-${t.id}`, '⧉ new session', () => runInNewSession($, t.id))}
              {action(`edit-${t.id}`, 'edit', () => startEdit($, t.id))}
              {action(`sub-${t.id}`, '+subtask', () => update($, parent, () => t.id))}
              {action(`pri-${t.id}`, 'priority', () => cyclePriority($, t.id))}
              {!isFlat && action(`up-${t.id}`, '↑', () => moveTask($, t.id, 'up'))}
              {!isFlat && action(`down-${t.id}`, '↓', () => moveTask($, t.id, 'down'))}
              {!isFlat && action(`top-${t.id}`, 'top', () => moveTask($, t.id, 'top'))}
              {action(`del-${t.id}`, 'delete', () => deleteTask($, t.id))}
            </Box>,
          ]
        : []),
      ...(isFlat ? [] : rows.filter(x => x.parent === t.id).flatMap(k => row(k, depth + 1))),
    ]

    const body: any[] = []
    let lastGroup = ''
    for (const t of roots) {
      if (v === 'today' || v === 'upcoming') {
        const group = t.due < today ? 'Overdue' : dueDay(t.due, today)
        if ((v === 'upcoming' || group === 'Overdue') && group !== lastGroup) {
          body.push(<Text key={`grp-${group}`} bold>{group}</Text>)
          lastGroup = group
        }
      }
      body.push(...row(t, 0))
    }

    const tab = (id: string, label: string, n: number) => (
      <Button
        key={`view-${id}`}
        plain={v !== id ? true : undefined}
        variant={v === id ? 'primary' : undefined}
        label={n > 0 ? `${label} ${n}` : label}
        onPress={() => update($, view, () => id)}
      />
    )

    const inputKey = ed ? 'edit' : 'new'
    const inputLabel = ed ? '✎ ' : '+ '
    const placeholder = ed ? 'Edit, then Enter' : 'Add a task…'

    return (
      <Box flexDirection="column">
        <Box gap={1} flexWrap="wrap">
          {tab('inbox', 'Inbox', count('inbox'))}
          {tab('today', 'Today', count('today'))}
          {tab('upcoming', 'Upcoming', count('upcoming'))}
          {projs.map((p: string) => tab(`p:${p}`, `#${p}`, count(`p:${p}`)))}
        </Box>
        <Input
          key={inputKey}
          label={inputLabel}
          placeholder={placeholder}
          value={text}
          onInput={(x: string) => update($, draft, () => x)}
          onSubmit={(x: string) => submitInput($, x)}
        />
        {(!!editTask || !!parentTask) && (
          <Box gap={1} flexWrap="wrap">
            <Text dimColor>
              {editTask ? `Editing: ${editTask.text}` : `Subtask of: ${parentTask?.text}`}
            </Text>
            {action('cancel-input', 'cancel', () => cancelInput($))}
          </Box>
        )}
        <Text bold>{title}</Text>
        {!!problem && <Text color="red">{problem}</Text>}
        {!problem && body.length === 0 && <Text dimColor>Nothing here.</Text>}
        {body}
        <Box gap={1} flexWrap="wrap">
          {!isFlat && action('toggle-done', withDone ? 'Hide completed' : 'Show completed', () => update($, showDone, (x: boolean) => !x))}
          {isProject && action('del-project', 'Delete project', () => deleteProject($, v.slice(2)))}
        </Box>
      </Box>
    )
  })
}
