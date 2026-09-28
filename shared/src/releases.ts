// ============================================================================
// §18 — What's new. The release notes ship with the code: every change that
// reaches the floor adds an entry here, newest first, so the note and the
// build are the same deploy. An administrator sees the entries newer than
// the last one they dismissed, once, when the application opens.
// ============================================================================

export interface ReleaseItem {
  /** One change, in plain words: what it does and where it is. */
  text: string
}

export interface Release {
  /** Sorts as text: the day, then a counter for a second release on the same day. */
  id: string
  /** ISO date of the deploy. */
  date: string
  title: string
  items: ReleaseItem[]
}

/**
 * Nothing before this id is ever shown as new: the feature starts with the
 * release after the one that introduced it.
 */
export const RELEASE_NOTES_BASELINE = '2026-09-15.1'

/** Newest first. Add a new entry at the top with a fresh id. */
export const RELEASES: readonly Release[] = [
  {
    id: '2026-09-28.3',
    date: '2026-09-28',
    title: 'Universal machines and their stages',
    items: [
      { text: 'Machines are roll forming, welding, painting or universal. Presses, benders, mast machines and every other machine are universal; the machines filed as Mast or Others moved there.' },
      { text: 'On a universal machine an item of an order can pass through several stages, a session each. The first session on the item closes as stage 1 as before; a later one asks, when it closes, which stage it was: one of the item\'s stages or a new one.' },
      { text: 'History shows "Stage 2" (and on) beside a session of a later stage. A supervisor corrects a stage in Correct quantities.' },
      { text: 'The dashboard reads a universal item\'s quantity from the order sheet (Finished on Access), once for all its stages, and its rejects from every stage. The final quantity typed at each close no longer counts the same pieces twice. A month counts the item once, and so does any period.' },
    ],
  },
  {
    id: '2026-09-28.2',
    date: '2026-09-28',
    title: 'PDI: the whole order, and in History',
    items: [
      { text: 'New PDI finds the order by any part of its number and shows every item of it, however many, each with its drawing number. Untick the items that do not ship this time; the PDI covers the rest.' },
      { text: 'A PDI shows its items with their drawing numbers. Tap one for its items, notes and photos.' },
      { text: 'History has a Sessions | PDI switch at the top. PDI lists every PDI on record, newest first, and filters by order, customer, item, drawing, note, who recorded it and date; Show older walks back as far as the record goes.' },
      { text: 'The PDI screen searches the whole record too, not only the latest fifty.' },
    ],
  },
  {
    id: '2026-09-28.1',
    date: '2026-09-28',
    title: 'Dashboard: choose the charts everyone sees',
    items: [
      { text: 'Arrange → Charts opens a gallery of every chart on General and Details. Untick a chart to hide it for everyone, tick it to show it again; Save layout keeps the choice. A chart shown again comes back at the bottom of its page.' },
      { text: 'Each chart also has Hide in its bar while arranging.' },
      { text: 'Moving or resizing a chart while arranging no longer drops the name and description an administrator gave it.' },
      { text: 'The First part released widget and its machine chart now read first part released: clean sessions ÷ all sessions, higher is better. First pass yield cumulative stays on its own card at the top.' },
    ],
  },
  {
    id: '2026-09-27.1',
    date: '2026-09-27',
    title: 'Dashboard: first part by part, Excel filters, fixed pies',
    items: [
      { text: 'Plant: trend starts on the first month with production instead of empty months, and grows to the last four months as time passes.' },
      { text: 'The factory cards read in name order: LM1, LM2, LM2-Ext., LM3, LM4.' },
      { text: 'By factory, the machine list is one list again, worst first whatever the factory; pick a factory and it ranks inside it. By process keeps the machines under their process.' },
      { text: 'Rejected by factory (or process) follows the period only, not the picks. A second pie beside it, all time, follows nothing. Rejected by machine follows the period and the factories or processes picked, not the ticked machines.' },
      { text: 'First part: the machine list takes several machines at once. The chart by machine now reads first pass yield cumulative per machine, month by month. A new chart counts the sessions by pieces rejected before release: 1 piece, 2, and so on.' },
      { text: 'Sessions not clean became Parts not clean: one row per part on a machine, how many of its sessions started with pieces already rejected, of how many, and the pieces. Tap a row for the orders behind it and open their sessions.' },
      { text: 'Every table of General filters like Excel: the funnel on a column header lists its values with ticks and a search. Clear filters shows every row again.' },
    ],
  },
  {
    id: '2026-09-26.6',
    date: '2026-09-26',
    title: 'Dashboard: picks back under the overview',
    items: [
      { text: 'The left column is gone: the picker, the factory or process chips and the machine list are back where they were, under the overview cards, with the machine list on the board. The two first-part cards no longer carry a machine list.' },
      { text: 'The three First part widgets share one machine list in their headers: pick a machine and all three read for it.' },
      { text: 'Arrange → Name on a chart: an administrator gives it a name and a description of their own, shown to everyone in place of the chart\'s own once the layout is saved. "Use its own" puts them back.' },
      { text: 'Plant: trend is the one chart nothing narrows: the last four months to today, the whole plant, a line for each factory. Factories by month and Machines by month now follow the period and the picks like everything else.' },
      { text: 'Four pies on the General board: Rejected by factory (or by process), Share of each defect, Rejected by machine, and Dispositions, each reading the period and the picks. Arrange them like any other chart.' },
      { text: 'The machine list is grouped: by process when reading by process, by factory when reading by factory, worst first in each group.' },
    ],
  },
  {
    id: '2026-09-26.4',
    date: '2026-09-26',
    title: 'By order line: one row per line',
    items: [
      { text: 'An order number can carry several item lines. By order line now shows each line on its own row, with its item, its rejected pieces and its Of made against what that line itself made; before, the lines of one order were summed under one item.' },
      { text: 'First part released is three widgets you can arrange on their own: the yield and months, the machines by month, and the sessions not clean. Each widget scrolls once, not twice; a chart fills the box it is given, taller or shorter.' },
      { text: 'Factories by month and Machines by month are plant-wide and answer to no filter or pick: the six machines with the highest reject rate over the last four months.' },
    ],
  },
  {
    id: '2026-09-26.3',
    date: '2026-09-26',
    title: 'Dashboard: arrange the charts',
    items: [
      { text: 'The charts of General (By factory / By process) and of Details sit on a grid. An administrator taps Arrange, drags a chart by its blue bar to move it and pulls its corner to size it, then Save keeps the arrangement for everyone; Default puts the original back.' },
      { text: 'Each chart keeps its own scroll inside its box, so a small box still shows the whole chart. On a tablet or phone the grid becomes a stack in the same order.' },
      { text: 'The two first-part cards carry a machine list of their own: pick a machine and the card reads for it alone. Every long table scrolls inside its box with its header pinned.' },
    ],
  },
  {
    id: '2026-09-26.2',
    date: '2026-09-26',
    title: 'Reset all, on every filter bar',
    items: [
      { text: 'Dashboard, History and Access each get a Reset all button that puts every filter back to how the tab opens the first time. On the Dashboard it also clears the factories, processes and machines picked on General.' },
    ],
  },
  {
    id: '2026-09-26.1',
    date: '2026-09-26',
    title: 'Dashboard: numbers on the charts, a line per factory, cumulative first pass yield',
    items: [
      { text: 'Every chart writes its numbers on the bars and points. The trend of a pick carries a line for each factory (or process) in it, all on the same chart.' },
      { text: 'Two month charts under the pick, Factories by month and Machines by month, run over the last four months to today whatever the period strip says; tick machines to choose the lines. The machine list scrolls.' },
      { text: 'The factory cards name the processes in the factory. First pass yield cumulative is a card of its own: rejected before release ÷ (clean sessions + rejected pieces); the Sessions card is gone.' },
      { text: 'Defects by month shows each defect\'s share of that month\'s rejected pieces against the other defects. By order line and By item: Of made is against what that order or item itself made, to three decimals; the last column is the share of the period.' },
      { text: 'First part released: the block reads by the cumulative formula, month by month too, and its chart is each machine\'s pieces rejected before release month by month.' },
    ],
  },
  {
    id: '2026-09-24.4',
    date: '2026-09-24',
    title: 'Dashboard: one period for everything, several factories at once',
    items: [
      { text: 'The period strip now sits above every page: General, By factory, By process, Details and Inspectors all count over it. The trend line on the General cards keeps its last four months.' },
      { text: 'By factory and By process take several picks at once (tap Factory 1 and Factory 2 to see them together), or All. The machines table at the top of General is gone; the machines live under the pick, worst first.' },
      { text: 'The breakdown shows a Pareto of defects. First part released is reworked: clean, not clean and the pieces rejected before release, a Pareto of those pieces by machine, the months, and the sessions that were not clean as a table.' },
    ],
  },
  {
    id: '2026-09-24.3',
    date: '2026-09-24',
    title: 'Dashboard: General reads by factory or by process',
    items: [
      { text: 'General now opens on three figures only, for the plant and each factory: trend (four months, with the change against the month before), reject rate and PPM. Then every machine on the same three.' },
      { text: 'Reject rate is rejected pieces per 100 made, where made = produced + rejected: a session\'s final quantity is its good production. Closing a session no longer refuses a final quantity below the rejected pieces.' },
      { text: 'Read it: By factory or By process. Pick one, see its trend and its machines against one another, tick several machines to compare them, and the breakdown follows: defects and their months, the rejected pieces of each month laid on the order lines and items, and first part released.' },
      { text: 'First part released is by session: clean when nothing was rejected on the line before the release inspection; 8 clean of 10 sessions is 80%. Shown by month, by machine, with the sessions that were not clean.' },
      { text: 'Details keeps the full analysis behind the period and filters, as before; the Machine filter of the analysis now accepts several machines.' },
    ],
  },
  {
    id: '2026-09-24.2',
    date: '2026-09-24',
    title: 'Dashboard: General and Analysis pages',
    items: [
      { text: 'Dashboard → General: the whole plant over the last 4 months with no filter: pieces produced, defect pieces, defect rate and released pieces; the rate month by month; and each factory\'s trend and figures.' },
      { text: 'Dashboard → Analysis: a Process filter (Roll forming, Welding, Painting, Universal machines, Mast machines, Others) that narrows the machine list and every figure. Each machine is a card: defect rate with its trend, produced, released and defective pieces.' },
      { text: 'Analysis also gets the period month by month, a Defect details table (pieces, days seen, orders seen, share), and a fixed right side listing defects by machine and by item, largest first. Everything that was on Overview follows below it, unchanged.' },
      { text: 'Admin → Machines: two more process groups, Universal machines and Mast machines; they run the forming wizard.' },
    ],
  },
  {
    id: '2026-09-24.1',
    date: '2026-09-24',
    title: 'Coils: the same coil on the next sample',
    items: [
      { text: 'The next sample already carries the previous sample\'s coils, so the same coil can be on as many samples as it feeds. In "Add coil" such a coil is now marked "On this sample" and stays tappable: a tap closes the picker and lights the coil on the list instead of greying it out.' },
    ],
  },
  {
    id: '2026-09-22.6',
    date: '2026-09-22',
    title: 'Access and History: the Item filter matches as you type',
    items: [{ text: 'Type any part of an item code or name and the table narrows to every line containing it. Picking from the list still works; nothing has to be chosen exactly.' }],
  },
  {
    id: '2026-09-22.5',
    date: '2026-09-22',
    title: 'Dashboard: hide an insight you have read',
    items: [
      { text: 'Dashboard → Insights: each card has a hide button. A hidden insight stays hidden for you on every device until you show it again from the "hidden" row at the bottom of the list.' },
      { text: 'Hiding is by rule and subject: hiding "machine 14 runs hot" does not hide the same finding about another machine. The bulb count, the print and the Excel export follow what you see.' },
    ],
  },
  {
    id: '2026-09-22.4',
    date: '2026-09-22',
    title: 'History: filter by item',
    items: [{ text: 'History → Item: type or pick an item (code — name) and the list narrows to the sessions inspecting it, the same way Access does. Kept with the other filters on the device.' }],
  },
  {
    id: '2026-09-22.3',
    date: '2026-09-22',
    title: 'Access: filter by item',
    items: [{ text: 'Access → Item: type or pick an item (code — name) from the sheet and the table narrows to its lines. Kept with the other filters on the device.' }],
  },
  {
    id: '2026-09-22.2',
    date: '2026-09-22',
    title: 'Notices: AND / OR, and adding many targets at once',
    items: [
      { text: 'Notices → Reach: "ALL of them (AND)" keeps the old rule (each kind must hold; within a kind any value); "ANY of them (OR)" reaches a reader through any one target: this machine OR this order OR this person.' },
      { text: 'Every target kind is now a list to tick several of and add at once: machines, people, factories, shifts, roles, order numbers, order lines. "All shown" ticks the whole filtered list.' },
      { text: 'Target an order number first and the Item code list offers the items of that order to tick; the Order line list shows its lines. An item code can still be typed.' },
      { text: 'The lists narrow as you go: a factory or a process narrows the machines; machines (or the factories\' machines) narrow the orders, lines, items and customers to what runs on them; an order narrows its items and lines.' },
      { text: 'Chat: an administrator adds people to a group after it was made, from the person-plus button at the top of the group, several at once.' },
    ],
  },
  {
    id: '2026-09-22.1',
    date: '2026-09-22',
    title: 'All the photos of a session, on one screen',
    items: [
      { text: 'Open a session in History or on the board: "Photos of this session" shows every photo taken in it, grouped as Defects, Paint, PT / weld and Notes, each with its sample number and what it is of. No need to open sample after sample.' },
      { text: 'Tap a photo to view it large and swipe through the group; tap the sample number to open that sample.' },
      { text: 'New inspection: "Rejected qty before release" starts at 0 on every line. It used to start at the line\'s remaining quantity.' },
    ],
  },
  {
    id: '2026-09-20.3',
    date: '2026-09-20',
    title: 'PT coverage from production; History by day',
    items: [
      { text: 'PT: the requirement is 5% of the final quantity, rounded up to a whole piece, worked out when a welding session is closed. Nobody types a frequency any more; the close dialog shows tested vs required as the quantity is typed, and History and the board show the same badge on the session.' },
      { text: 'History → Date range → "A day or a range…": pick one day or a From/To range; a session counts on the days it was started or sampled.' },
    ],
  },
  {
    id: '2026-09-20.2',
    date: '2026-09-20',
    title: 'Access first, and tables that fit',
    items: [
      { text: 'Access is the first tab, for supervisors, administrators and viewers; inspectors do not see it.' },
      { text: 'History and Access tables scroll inside a frame: the header stays put and both scrollbars are on screen however many columns are shown.' },
      { text: 'Fit columns (desktop) sizes every column to what is in it; a few columns spread over the width instead of huddling on the left.' },
    ],
  },
  {
    id: '2026-09-20.1',
    date: '2026-09-20',
    title: 'Access: the order sheet as a table',
    items: [
      { text: 'A new Access tab shows the ERP order sheet as it was uploaded, for everyone. Search any word of a line; filter by machine, factory, ERP status, remaining quantity and whether the line was inspected. Every filter runs over the whole sheet.' },
      { text: 'Columns: choose the ones you need (line key, drawing, material, colour, and the inspection figures per line: sessions, samples, defect pieces, last inspected) and drag them wider on a desktop, as in History.' },
      { text: 'A line that was inspected opens History on its order number.' },
    ],
  },
  {
    id: '2026-09-16.1',
    date: '2026-09-16',
    title: 'Defect rate over production',
    items: [
      { text: 'Dashboard → Defect rate is now defect pieces per 100 produced: the final quantities of the sessions closed in the period. The tile says how many pieces and sessions it stands on. A session still open has no rate until it is closed.' },
      { text: 'By machine and by item the rate is over production too. By shift, by inspector and by coil supplier it stays "of inspected", since a session\'s production cannot be split between them; the titles say so.' },
      { text: 'First-pass yield counts samples with no defect recorded. A dimension out of tolerance no longer lowers it; "Dimensions out of tolerance" keeps its own tile.' },
      { text: 'Closing a session refuses a final quantity below the defective pieces recorded in it: the defect quantities are the defective pieces of the batch.' },
      { text: 'History → Defect % is over the final quantity; "Defect % of inspected" is there under Columns.' },
    ],
  },
  {
    id: '2026-09-15.2',
    date: '2026-09-15',
    title: 'A viewer role',
    items: [
      { text: 'Users → a new role, Viewer: signs in to read the board, History and the dashboard, and changes nothing. No new inspection, no continue or close, no corrections, no deletions.' },
      { text: 'A viewer has no chat, no notices and no gear menu. The API refuses every write for the role, so the limits hold whatever the screen shows.' },
      { text: 'History → Columns: the table now carries pieces inspected, defect records, defect pieces, defect % and more; tick the ones you need and drag them wider on a desktop.' },
    ],
  },
  {
    id: '2026-09-15.1',
    date: '2026-09-15',
    title: "What's new, in the application",
    items: [
      { text: 'Administrators see a note like this one the first time they open the application after an update. It lists what changed and where to find it.' },
      { text: "Earlier notes stay under the gear menu → What's new." },
    ],
  },
]

const byIdDesc = (a: Release, b: Release) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The entries newer than what this person has dismissed (or than the baseline), newest first. */
export function unseenReleases(lastSeenId: string | null | undefined, releases: readonly Release[] = RELEASES): Release[] {
  const floor = lastSeenId && lastSeenId > RELEASE_NOTES_BASELINE ? lastSeenId : RELEASE_NOTES_BASELINE
  return releases.filter((r) => r.id > floor).sort(byIdDesc)
}

export function latestReleaseId(releases: readonly Release[] = RELEASES): string | null {
  return releases.length ? [...releases].sort(byIdDesc)[0].id : null
}

export function isReleaseId(id: string, releases: readonly Release[] = RELEASES): boolean {
  return releases.some((r) => r.id === id)
}
