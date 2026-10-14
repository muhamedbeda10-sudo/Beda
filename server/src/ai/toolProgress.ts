// ============================================================================
// §20 — the line under an answer while the model writes a tool's input, and
// while the app then checks what it wrote. Writing a long input (a report's
// draft with every query of it, four of them for one request) takes minutes
// with no words to show: without this line the answer looks stuck, its caret
// after its last sentence, and people stop it.
// ============================================================================

/** What the model is writing, by tool. */
const WRITING: Readonly<Record<string, string>> = {
  run_sql: 'Writing a query',
  propose_automation: 'Writing the automation',
  change_automation: 'Writing the change to the automation',
  propose_notice_change: 'Writing the notice',
  propose_task: 'Writing the task',
  update_playbook: 'Writing to the playbook',
  save_table: 'Writing the table to save',
  update_saved_table: 'Writing the change to the saved table',
  make_excel: 'Writing the Excel file',
}

/** What the app does with a step's tools before its first card: run_sql's card says so itself. */
const CHECKING: Readonly<Record<string, string>> = {
  propose_automation: 'Checking the automation and running it once',
  change_automation: 'Making the change, checking it and running it once',
  propose_notice_change: 'Checking the notice',
  propose_task: 'Checking the task',
  update_playbook: 'Saving to the playbook',
  save_table: 'Saving the table',
  update_saved_table: 'Changing the saved table',
  refresh_saved_table: 'Computing the saved table again',
  remove_saved_table: 'Removing the saved table',
  make_excel: 'Making the Excel file',
  find_people: 'Looking people up',
  find_notice_targets: 'Looking up who can be told',
  list_notices: 'Reading the notices',
  notice_details: 'Reading the notice',
  my_automations: 'Reading your automations',
  my_tasks: 'Reading your tasks',
  list_saved_tables: 'Reading the saved tables',
}

/** Writing for this long before the line counts the seconds. */
const COUNT_AFTER_SECONDS = 5

/** "Writing the automation…", then "Writing the automation… 40 s" once it takes a while. */
export function writingLine(tool: string, seconds: number): string {
  const what = WRITING[tool] ?? 'Preparing the next step'
  const s = Math.floor(seconds)
  return s < COUNT_AFTER_SECONDS ? `${what}…` : `${what}… ${s} s`
}

/** What the app does with a step's tools, said before it starts; null when the tool's own card says so (run_sql). */
export function checkingLine(tools: readonly string[]): string | null {
  const first = tools[0]
  if (first === undefined || first === 'run_sql') return null
  return `${CHECKING[first] ?? 'Working on it'}…`
}
