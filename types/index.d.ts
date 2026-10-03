export type Task = {
  id: number
  text: string
  isDone: boolean
  priority: 1 | 2 | 3 | 4
  project: string
  labels: string[]
  due: string
  time: string
  recur: string
  parent: number
}

declare module 'claude-code' {
  interface PluginState {
    'todo-list': {
      items: Task[]
      projects: string[]
      view: string
      draft: string
      parent: number
      selected: number
      editing: number
      showDone: boolean
    }
  }
}
