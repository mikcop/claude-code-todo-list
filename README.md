# claude-code-todo-list

A Todoist-style task manager that lives inside [Claude Code](https://claude.com/claude-code):
a side pane, a `/todo` slash command, and tools Claude itself can call, so you can say
"add a task to call Marco tomorrow at 3pm" in plain language.

Tasks are stored locally in the plugin's own store (a JSON file under `~/.claude/plugins/store/`)
and are shared by every session on your machine. Nothing is sent anywhere.

> Not affiliated with or endorsed by Todoist / Doist. Built and tested with Claude Code 2.1.288.

## Features

- **Projects, priorities p1–p4, labels, subtasks** and an **Inbox**
- **Views:** Inbox, Today (with overdue), Upcoming (grouped by day) and one per project
- **Quick add**, Todoist style: `Pay rent tomorrow at 9:30 p1 #Home @bills`
  - dates: `today`, `tomorrow`, `mon`, `in 3 days`, `next week`, `2026-10-20`, `20/10` (day/month);
    Italian words work too (`oggi`, `domani`, `lun`, `alle 15:00`, `ogni settimana`)
  - times: `at 14:30`, `3pm`
  - recurrence: `every day`, `every week`, `every month`, `every weekday`, `every mon`
- Recurring tasks move to their next date when completed
- **Edit** a task from the pane (the field is filled with its quick-add line) or with `/todo edit`
- **Reorder** inside a project with `↑` / `↓` / `top` (a terminal has no real drag and drop)
- **Reminders:** a toast at the minute a timed task is due (only while Claude Code is open)
- **Run a task with Claude:**
  - `▶ run here` sends the task to the current session as a prompt
  - `⧉ new session` opens a new Terminal window with `claude` started on the task (macOS)
- Status line entry: `todo N today`

## Install

As a plugin from this repository:

```sh
claude plugin marketplace add mikcop/claude-code-todo-list
claude plugin install todo-list@claude-code-todo-list
```

Or load it for one session, without installing:

```sh
git clone https://github.com/mikcop/claude-code-todo-list
claude --plugin-dir ./claude-code-todo-list
```

## Use

| Command | What it does |
| --- | --- |
| `/todo` | open the pane |
| `/todo <text>` or `/todo add <text>` | add a task (quick-add syntax) |
| `/todo done <id>` | complete a task (reopens it if done; a recurring one moves to its next date) |
| `/todo rm <id>` | delete a task and its subtasks |
| `/todo edit <id> <text>` | rewrite a task from a quick-add line |
| `/todo move <id> up\|down\|top` | reorder a task inside its project |
| `/todo list [view]` | print tasks with ids; view is `inbox`, `today`, `upcoming`, `all` or a project name |
| `/todo project <name>` | create a project |
| `/todo clear` | delete completed tasks |

In the pane, click `○` to complete a task and `⋯` to open its actions
(`▶ run here`, `⧉ new session`, `edit`, `+subtask`, `priority`, `↑`, `↓`, `top`, `delete`).

Claude can also call `todo_list`, `todo_add`, `todo_update`, `todo_complete` and `todo_delete`
(listed as `mcp__todo-list__…`), so natural-language requests work in chat.

## Good to know

- Every session reads the list when it starts and rewrites the whole list when it saves.
  Two sessions editing at the same time can overwrite each other's changes.
- `⧉ new session` needs macOS and the `claude` command on the `PATH` of Terminal; macOS may ask
  for permission to control Terminal the first time. The new session starts in the current
  session's working directory and does not have this plugin's tools unless the plugin is installed.
- A `/todo` command with a known verb and the wrong arguments prints its usage;
  any other text becomes a new task.

## Development

The plugin is a hooks module: [`hooks/register.tsx`](hooks/register.tsx).
Its types live in [`types/index.d.ts`](types/index.d.ts).

```sh
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
