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
  /** The day, then a counter for a further release on the same day: "2026-10-13.2". Ordered by compareReleaseIds. */
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
    id: '2026-10-14.1',
    date: '2026-10-14',
    title: 'The assistant says what it is writing, and changes an activated automation without a refusal',
    items: [
      { text: 'While the assistant writes an automation, a notice, a task, a query or a playbook entry, the line under its answer says so ("Writing the automation… 40 s"), then "Checking the automation and running it once…". Before, the answer could sit for minutes with only its cursor showing, as if it had stopped.' },
      { text: 'Asking to change an automation you already activated from its card now proposes the change to that automation straight away, with Activate to apply it. Before, the assistant was told "that proposal was activated" and had to write the whole automation again.' },
    ],
  },
  {
    id: '2026-10-13.109',
    date: '2026-10-13',
    title: 'Conversations named by the assistant',
    items: [
      { text: 'A new conversation with the assistant is given a short title of a few words on what it is about — in the language you asked in — instead of the start of your first question. It appears in the list and at the top of the conversation while the answer is being written.' },
      { text: 'A title you gave a conversation yourself (Rename in its menu) is never changed. If the title cannot be made, the start of the first question stays, as before. It costs a tiny part of a cent a conversation, counted with the question.' },
    ],
  },
  {
    id: '2026-10-13.108',
    date: '2026-10-13',
    title: 'The assistant finishes its answers on its own',
    items: [
      { text: 'An answer now goes on when you close the page, refresh it or put the phone away: only Stop ends it early. Open the conversation again, here or on another device, and it shows how far the answer has got, with its Stop.' },
      { text: 'When an answer ends while you are not looking at it, the bell says so (AI assistant), and it reaches your phone like any other alert; tapping it opens the conversation.' },
      { text: 'If the server restarts in the middle of an answer, the answer goes on from the step it had reached, without starting again.' },
      { text: 'One answer may take up to 30 minutes. As it nears its time or its steps, the assistant saves what is worth keeping and closes with what it found and what remains, so you can ask it to go on.' },
    ],
  },
  {
    id: '2026-10-13.107',
    date: '2026-10-13',
    title: 'The assistant changes a saved table in place',
    items: [
      { text: 'Ask the assistant to change a saved table — its title, summary or description, a column\'s note, how often it is computed, its query, or the rows written in it (add rows, replace them, change the columns) — and it changes that table where it is, without removing it and making it again. Its name stays, so questions, reports and automations that read it go on reading it.' },
      { text: 'A change to its words or schedule keeps its rows as they are; a change to its query or rows computes it again at once. The card in the answer says "Saved table updated" or "Saved table changed".' },
    ],
  },
  {
    id: '2026-10-13.106',
    date: '2026-10-13',
    title: 'Your conversations with the assistant, kept in order',
    items: [
      { text: 'Pin conversations to the top of the list (up to 30), rename any of them, and put them in groups of your own — each conversation in one group. A group opens in place in the list; removing a group sends its conversations back to the list, none deleted.' },
      { text: 'Archive a conversation to keep it out of the way without deleting it: it is under Archived at the end of the list, and asking in it again brings it back.' },
      { text: 'The search now reads every conversation, archived ones too — titles, questions and answers — and shows the words around what it found. Arabic is found however it is written: اجابة finds إجابة.' },
      { text: 'All of it is in the menu (⋯) beside each conversation and each group. Your groups and pins are yours alone.' },
    ],
  },
  {
    id: '2026-10-13.105',
    date: '2026-10-13',
    title: 'Saved tables, simpler to read',
    items: [
      { text: 'Each table on the Saved tables page now shows its title, a sentence or two on what it shows, how many rows it has and when they were computed, and the table itself, open at once. The full description, the columns, who may read it, who made it and how it is computed are under Details.' },
      { text: 'The assistant writes that short summary when it saves or replaces a table. A table saved before this shows the first sentence of its description until the assistant replaces it.' },
    ],
  },
  {
    id: '2026-10-13.104',
    date: '2026-10-13',
    title: 'The assistant expands to the full screen',
    items: [
      { text: 'Expanding the AI assistant (the arrows at the top of its card, now "Full screen") fills the whole screen instead of a large window in the middle, with your conversations and reports beside the chat. Shrink puts it back in the corner.' },
    ],
  },
  {
    id: '2026-10-13.103',
    date: '2026-10-13',
    title: 'The dashboard, tidied',
    items: [
      { text: 'The filters are together at the top: the view and the period on the first row; By factory, Comparisons or Details with the factories beside them on the second, the page\'s buttons at its end. Every control on a row is the same height.' },
      { text: 'The plant and its factories are one row of cards side by side on a wide screen, each the same size with its figures level with the next card\'s; on a phone they are one under another.' },
    ],
  },
  {
    id: '2026-10-13.102',
    date: '2026-10-13',
    title: 'The assistant takes on bigger analyses, and keeps what it builds',
    items: [
      { text: 'Ask for an analysis that takes real work — a routing drawn from two years of production, a normal scrap range per item, a ranking of suppliers — and the assistant works it out in steps, checking its figures as it goes. One answer may now take many more steps and up to 15 minutes, and a query up to 30 seconds.' },
      { text: 'What is worth building on, it keeps as a saved table, shown as a card in its answer. A table drawn from the record is computed again by itself (every night, or every hour); questions, reports and automations then build on it — for example, an alert when an item passes a work center its routing does not have.' },
      { text: 'The new table icon in the assistant\'s header opens Saved tables: what each table holds, how often it is computed, its first rows, Compute now, and Remove for whoever made it. A table is shown only to people who may read everything it is built from.' },
    ],
  },
  {
    id: '2026-10-13.101',
    date: '2026-10-13',
    title: 'The order sheet brings the ERP\'s other columns',
    items: [
      { text: 'Data import → Production orders now reads the whole of the ERP\'s Tasks sheet: besides the columns it already read, 42 more — due, refined and planned dates, the planning week, the ERP\'s remaining, cancelled, accepted and stock quantities, size and weight, painting area and powder, raw material, QC totals, shipping status and days, and delays. Import the same file again to fill them in on the lines already there.' },
      { text: 'For these new columns the file is the truth: a cell left empty clears what was stored. An empty cell in the columns read before still leaves the stored value alone.' },
      { text: 'Access has each of them under Columns, ready to filter and sort like the others; the planning week sorts by year, then week. The AI assistant can read them too, in the order lines.' },
    ],
  },
  {
    id: '2026-10-13.100',
    date: '2026-10-13',
    title: 'Notices open from the bell, and are written with the assistant',
    items: [
      { text: 'Notices are no longer under Administration. Whoever writes them opens the Notices page from the bell: the Notices tab has "Open the Notices page" under the list.' },
      { text: 'A new notice is written with the AI assistant: on the Notices page, "New notice" is now "New in the assistant", which opens it on a new conversation to draft the notice as a card you publish. The page still shows who read each notice, and changes, withdraws or removes one.' },
      { text: 'The assistant\'s round button no longer covers Send in the chat: it sits above the message box.' },
    ],
  },
  {
    id: '2026-10-13.99',
    date: '2026-10-13',
    title: 'Administration pages, tidied',
    items: [
      { text: 'The administration sections sit in one compact list on the left that stays in view while a page scrolls; each page has its title, a line on what it is for and its buttons on one row.' },
      { text: 'Configuration\'s sections are one row of tabs. Data import keeps Download CSV template beside its heading. The audit log\'s counts are one strip, and its search and filters one line on a wide screen.' },
      { text: 'What\'s new opens the newest updates and folds the others to their titles, under their day, with a search and Open all / Fold all.' },
    ],
  },
  {
    id: '2026-10-13.97',
    date: '2026-10-13',
    title: 'Print reports from the assistant',
    items: [
      { text: 'Print, under any answer of the AI assistant, prints it on its own, laid out for paper: the question as its title, the headline figures, the text, and each chart with its rows. In the print window, Save as PDF makes a PDF file.' },
      { text: 'A saved report has Print beside Run again (it prints the days and rows on screen), and a report delivered by an automation has Print beside Export Excel.' },
      { text: 'Each printed page says what it is, the period, when its data was read, and who printed it and when. Ask the assistant for a report to print, and it writes the answer as one.' },
    ],
  },
  {
    id: '2026-10-13.96',
    date: '2026-10-13',
    title: 'Panels open in the middle of the screen',
    items: [
      { text: 'The bell, a follow-up, an order\'s details, an audit entry, your mentions in the chat, the automation editor and a person\'s assistant access now open as a large window in the middle of the screen, the size of the assistant\'s large window, no longer as a panel down the right side. The page stays behind it; press outside it, × or Esc to close it.' },
      { text: 'On a phone they still slide up from the bottom, where your thumb reaches them.' },
    ],
  },
  {
    id: '2026-10-13.95',
    date: '2026-10-13',
    title: 'Excel from the assistant follows its permission',
    items: [
      { text: 'Every Excel button in the AI assistant now follows "Can have Excel files made": on a query card, under a chart, on a table in an answer, and Export Excel on a saved report. Without it, the tables are still there to open and copy. The assistant\'s owner always has it.' },
      { text: 'Reports that automations deliver keep their Excel for whoever receives them.' },
    ],
  },
  {
    id: '2026-10-13.94',
    date: '2026-10-13',
    title: 'Excel files from the AI assistant',
    items: [
      { text: 'Ask the AI assistant for data in Excel, laid out your way: the columns, their order and headings, totals, a title and a line of notes, on one sheet or several (per machine, per month, a summary and its details). When the period or the place is not clear, it asks first.' },
      { text: 'The file is made on the server from the record and comes as a card in the answer, with Download: a bold header frozen at the top with filters, real numbers, percentages and dates, totals that follow the filter, right to left for Arabic, and ready to print. The assistant never sees the rows.' },
      { text: 'A sheet holds up to 50,000 rows; for more, the assistant asks you to narrow it. Files are kept 30 days.' },
      { text: 'The assistant\'s owner decides who may have files made, person by person: "Can have Excel files made" in Who can use it, on the assistant\'s settings. Every request and every download is logged.' },
    ],
  },
  {
    id: '2026-10-13.93',
    date: '2026-10-13',
    title: 'The AI assistant floats in the corner',
    items: [
      { text: 'The AI assistant is now a round button in the bottom-right corner of every page, no longer an icon in the bar at the top. Press it and the assistant opens as a card in the corner; the page beside it stays usable.' },
      { text: 'Expand (the arrows at the top of the card) opens it as a large window in the middle of the screen, with your conversations and reports beside the chat; Shrink puts it back in the corner. On a phone it takes the whole screen.' },
      { text: 'The Automations and Playbook buttons at the top of the assistant open those pages inside it, with Back and a button back to the chat. A link to any other page (a session, a task, the follow-ups) opens that page, and the assistant moves to the corner beside it.' },
      { text: 'On screens with buttons along the bottom (recording an inspection, a selection\'s toolbar), the assistant\'s button sits above them.' },
    ],
  },
  {
    id: '2026-10-13.92',
    date: '2026-10-13',
    title: 'Tasks are sent through the assistant',
    items: [
      { text: 'On the Tasks page, “New task” is now “New in the assistant”: it opens the AI assistant in a new conversation, where you say what is to be done, by whom and by when, and it drafts the task as a card for you to send. Everything else on the page stays as it was.' },
      { text: 'Tasks are no longer in the assistant’s header: they stay in the bell, in the Tasks tab, with “Open the Tasks page”.' },
    ],
  },
  {
    id: '2026-10-13.91',
    date: '2026-10-13',
    title: 'Scheduled reports have their own tab in the bell',
    items: [
      { text: 'The scheduled reports sent to you now arrive in the bell\'s new Reports tab, beside Alerts, with the number not opened yet on the tab. Opening one shows the report as before.' },
      { text: 'Alerts keeps what needs acting on: what automations find, follow-ups and tasks, and a report that stopped. "Mark all as read" on each tab reads only that tab.' },
      { text: 'Reports already delivered moved to the Reports tab too.' },
    ],
  },
  {
    id: '2026-10-13.9',
    date: '2026-10-13',
    title: 'Every chart can show its table',
    items: [
      { text: 'Every chart now has a Chart / Table switch: on the dashboard (in each card’s header), in the AI assistant’s answers, in saved reports and in automation reports. Table shows the figures the chart draws, row by row.' },
      { text: 'In the assistant’s answers the chart and its table no longer sit one under the other: the chart shows first and Table switches to the rows. Open table and Export Excel stay under both.' },
    ],
  },
  {
    id: '2026-10-13.8',
    date: '2026-10-13',
    title: 'Six new charts for planning and production',
    items: [
      { text: 'The AI assistant draws six new kinds of chart: progress (how far each order or machine is toward its target), funnel (from required to produced to passed), waterfall (how the plan turned into what was made: downtime, rejects, overtime), gantt (plan and actual in time, by order line or machine), dumbbell (planned against actual hours, last month against this one) and treemap (the parts of a whole, grouped by factory or process).' },
      { text: 'The assistant now answers about planning and production as well as quality: plan against actual, order progress, machine load and output, hours and efficiency, from the order sheet and the ERP production record you can read.' },
      { text: 'They work in answers, in saved reports and in scheduled reports, like the other charts. Ask for one by name, or let the assistant choose.' },
    ],
  },
  {
    id: '2026-10-13.7',
    date: '2026-10-13',
    title: 'The assistant remembers: your playbook',
    items: [
      { text: 'Tell the AI assistant how you want it to work, and it remembers: "from now on, give rates as % with last month beside them", "always answer in Arabic", "remember that machine 58 is the old welder". It follows them in every new conversation.' },
      { text: 'Ask it to analyse the data and keep what you concluded: "keep this conclusion". It saves the conclusion with what it was drawn from (the data and the period), bears it in mind in later answers, and checks it against the data when an answer rests on it.' },
      { text: 'Each thing it saves shows in the chat as a small card with Remove. The new Playbook page (the book icon at the top of the chat) lists your instructions and conclusions: add, change or remove them there too.' },
      { text: "The assistant's owner can also set instructions for everyone from the Playbook page." },
    ],
  },
  {
    id: '2026-10-13.6',
    date: '2026-10-13',
    title: 'The assistant drafts tasks for you',
    items: [
      { text: 'Ask the AI assistant to send a task, in your own words: "Send Cyril a task to recheck the coil stock in bay 3 by tomorrow 10:00". It finds the people by name and shows the task as a card: what is to be done, the details, who it goes to, how urgent and the deadline.' },
      { text: 'Nothing is sent until you press "Send task" on the card; each person is then told in the bell. Ask for a change ("make it urgent", "add Sara too") and a new card replaces the old one. "Discard" sets it aside.' },
      { text: 'Ask about your tasks too: "who has not finished the coil task?", "what is overdue?", "what was sent to me?". The assistant answers from your own tasks only, with links to them.' },
      { text: 'This works in conversations started from now on.' },
    ],
  },
  {
    id: '2026-10-13.5',
    date: '2026-10-13',
    title: 'Tasks: send work to people and follow it to the end',
    items: [
      { text: 'New: Tasks. If you have the AI assistant, open Tasks from the list icon at the top of the chat, then "New task": what is to be done, details, one or more people, the priority and a deadline. Each person is told at once in the bell (and on their phone).' },
      { text: 'The people it was sent to find it in the bell, in its new Tasks tab. They press Start, write on the task and add photos, then Mark done with a word on what they did.' },
      { text: 'You are told when someone marks it done. Press "Confirm done" and it leaves their list, or "Not yet" with what is still to do, and it stays on their list. The task closes by itself once everyone is confirmed. You can also change it, close it for everyone, or withdraw it.' },
      { text: 'Only the sender and the people it went to see a task. Every step is written on its thread with who did it and when.' },
    ],
  },
  {
    id: '2026-10-13.4',
    date: '2026-10-13',
    title: 'Automations and Follow-ups have moved',
    items: [
      { text: 'Automations now open from the AI assistant: the lightning icon at the top of the chat, beside My reports. The tab in the bar at the top of the app is gone.' },
      { text: 'Follow-ups now open from the bell, in its own Follow-ups tab beside Notices and Alerts: your open follow-ups, overdue first, with the number on the tab (red when one is overdue). "Open the Follow-ups page" there shows them all, with the filters. The tab in the top bar is gone.' },
    ],
  },
  {
    id: '2026-10-13.3',
    date: '2026-10-13',
    title: 'The assistant costs less per question',
    items: [
      { text: 'The AI assistant now loads only the tools a question needs. A question about inspections, orders or production carries just its query tool; the tools for automations and notices are looked up and loaded only when you ask about them, and stay ready for the rest of that conversation. Each answer sends Claude less, so it costs less and the assistant picks the right tool more reliably.' },
      { text: 'This applies to conversations started from now on; earlier conversations go on as they were.' },
    ],
  },
  {
    id: '2026-10-13.2',
    date: '2026-10-13',
    title: 'Every kind of chart, in answers and in reports',
    items: [
      { text: 'The AI assistant now draws many more kinds of chart, choosing the one that fits the question: horizontal bars for rankings and long names, 100% stacked bars for a mix of defects, stacked areas, a combo of bars and a line on two axes (production with its reject rate), a Pareto of the main causes, a scatter with its trend line (how two measures move together), a heatmap (machine by day) and an SPC control chart with its centre line and limits, marking the points out of control in red.' },
      { text: 'A chart can carry a target line, for example a 2% reject-rate target or a nominal length. Ask for "charts" or "a dashboard of the week" and an answer can hold several charts of different kinds.' },
      { text: 'Saved reports keep the charts their answer had and draw them from each run. Scheduled reports can have a chart in every section: the assistant proposes them, the card shows them before you activate it, and each delivered report draws them from its own figures.' },
    ],
  },
  {
    id: '2026-10-13.1',
    date: '2026-10-13',
    title: 'The assistant reads photos, PDFs and Excel files',
    items: [
      { text: 'In the AI assistant, tap the paperclip beside the question box to attach up to 5 files to a question: photos (a handwritten inspection sheet, a label, a screen), PDFs (a mill certificate, a drawing, a report) and spreadsheets (.xlsx or .csv). You can also paste a photo into the box, or drop files on it.' },
      { text: 'Ask about them in words, or send the files alone and the assistant says what they hold. It copies handwriting figure by figure and marks anything it cannot read as [unclear] rather than guessing; it can also compare a file with the factory record, for example a handwritten sheet with the session in the system.' },
      { text: 'The files stay with the question: tap a photo to see it full size, or a PDF to open it. Old Excel files (.xls) must be saved as .xlsx first; a very long PDF or spreadsheet is refused with a word on what to attach instead.' },
    ],
  },
  {
    id: '2026-10-12.3',
    date: '2026-10-12',
    title: 'A tidier Automations page',
    items: [
      { text: 'Automations are listed in two parts, Watches and Scheduled reports, each with its count and what it does.' },
      { text: 'Each one shows its name with a line on what it does; Arabic names line up with the rest. Its state is shown only when it is not simply on (paused, failed or blocked), and a failed last run says so in red.' },
      { text: 'The columns sit evenly across the page; open follow-ups show as a badge, and the on/off switch is at the end of the row.' },
    ],
  },
  {
    id: '2026-10-12.2',
    date: '2026-10-12',
    title: 'Notifications: the browser asks for you',
    items: [
      { text: 'No need to look for the setting: the first time you tap anywhere in the app, the browser asks whether to allow notifications. Choose Allow, and alerts, chat messages and notices reach this device with its sound, even with the app closed. Signing in again later turns them on by itself.' },
      { text: 'Closed the question without answering? It is asked again the next time the app opens. To stop them on a device, tap your photo, then "Turn off".' },
      { text: 'The "Send a test" button is gone.' },
    ],
  },
  {
    id: '2026-10-12.1',
    date: '2026-10-12',
    title: 'Notifications with sound, even with the app closed',
    items: [
      { text: 'Turn on notifications for your phone, tablet or computer: tap your photo at the top right (on a phone, the menu), then "Turn on notifications" and allow them. Alerts from the bell, chat messages sent to you and notices for you then arrive with the device’s sound, even when the app or the browser is closed. Tap one to open what it is about.' },
      { text: 'iPhone and iPad: add the app to the Home Screen first (Share, then "Add to Home Screen"), open it from there, then turn notifications on.' },
      { text: 'While the app is open in front of you, a short chime plays instead; "Sound while the app is open" turns it off on that device.' },
      { text: 'Signing out turns notifications off on that device, so a shared tablet never shows the last person’s messages; they come back when the same person signs in again.' },
    ],
  },
  {
    id: '2026-10-11.3',
    date: '2026-10-11',
    title: 'Better on phones and tablets',
    items: [
      { text: 'Every page was checked on phones and tablets, upright and on their side: nothing scrolls sideways any more, buttons and links are big enough for a finger, tables keep the row\'s name in view while the figures scroll, and menus open as sheets from the bottom on a phone.' },
      { text: 'Tooltips open with a long press on a touch screen; typing in a box no longer zooms the page on an iPhone.' },
      { text: 'Inspection: when a welding sample cannot be saved because the connector coil number is missing, the Setup step opens with that box highlighted, and the setup summary on the later steps shows the number.' },
      { text: 'Coil search: each "Used in" entry now opens that sample in History.' },
      { text: 'History on a tablet shows the defect pieces and the final quantity right after the status.' },
    ],
  },
  {
    id: '2026-10-11.2',
    date: '2026-10-11',
    title: 'Connector coil number, watch hours, and Arabic chat messages',
    items: [
      { text: 'Welding machines: the Setup step has a new required field, Connector coil number, under the welding wire batch. It is remembered from the previous sample of the session, shown on the sample in History, and a welding sample cannot be saved without it.' },
      { text: 'Automations: a watch can now run only in some hours of the day and on some days, for example every 5 minutes from 05:00 to 10:00, Saturday to Thursday (factory time). Set it under Edit, "When it looks", or ask the assistant. Hours such as 22:00 to 06:00 cover the night.' },
      { text: "An automation's page no longer shows its run history table or its query. When its last run failed, the page says why." },
      { text: 'Chat: a message written mostly in Arabic now reads right to left even when it starts with an English word, in the conversation, the reply quote, the list of conversations and the message box.' },
    ],
  },
  {
    id: '2026-10-11.1',
    date: '2026-10-11',
    title: "The ERP's production record: import it, ask the assistant about it",
    items: [
      { text: "Administration → Data import has a new tab, Production record: load the ERP's production task record export (CSV or Excel) as it is. Each row is an order line on one working day — what the machine made, who stood at it, the shift, the hours and the weights — linked to the order sheet by its Order ID. Importing again updates and adds; rows missing from a later file are kept." },
      { text: 'The AI assistant can read it as a new data area, Production record, which is given to each person separately. It answers questions such as what a machine made last month and who worked it, or which order lines are behind what was required.' },
    ],
  },
  {
    id: '2026-10-10.3',
    date: '2026-10-10',
    title: 'Notices through the AI assistant, and a tidier header',
    items: [
      { text: 'Ask the assistant about notices: everyone about the ones in their own bell, administrators about every notice and who has read or acknowledged it.' },
      { text: 'Administrators who are allowed can have the assistant write a notice in plain words — what it says, who sees it and when — or change, withdraw or delete one. It shows a card with the notice exactly as it will look, who it reaches and its days; nothing changes until Publish (or Apply, Withdraw, Delete) is pressed. Photos and files are still added on the Notices page.' },
      { text: 'Light or dark is now chosen under your photo (on a phone, at the bottom of the menu), and the AI assistant has its button on phones too.' },
    ],
  },
  {
    id: '2026-10-10.2',
    date: '2026-10-10',
    title: 'AI assistant: asks, explains and agrees first',
    items: [
      { text: 'When a question could mean different things that would change the answer, the assistant asks first — at most three short questions, each with the choice it would make. When something cannot be done as asked, it explains why in terms of what the system records, offers two or three ways forward (any that would need a change in the app are marked as needing development) and recommends one.' },
      { text: 'Automations are agreed in words first: the assistant describes what it would watch or report, when, who is told and what it finds today, and shows the card with Activate only after you agree. Ask for a change and the new card marks the older one "Replaced".' },
      { text: 'The buttons under an answer are now called "Suggestions": when the assistant has asked you something, they are likely replies. Tap one to put it in the box, change it if you like, then send.' },
    ],
  },
  {
    id: '2026-10-10.1',
    date: '2026-10-10',
    title: 'Automations, follow-ups and alerts',
    items: [
      { text: 'People allowed to automate can ask the AI assistant in their own words to watch for something ("tell me when a sample has a Hold defect") or to send a report every day, week or month. It answers with a card showing what it would do and what it finds today; nothing runs until Activate is pressed. Automations only send alerts and open follow-ups — they never change a record.' },
      { text: 'Follow-ups: a new page with the follow-ups assigned to you (or everyone\'s, for supervisors and administrators), their deadlines, comments and status. An overdue follow-up is escalated once. Sessions with an open follow-up show a "Needs review" flag in History.' },
      { text: 'The bell has a new Alerts tab next to Notices, and automated messages arrive in the chat from "QC Automations". Scheduled reports open on their own page, with the assistant\'s summary and Excel export.' },
    ],
  },
  {
    id: '2026-10-09.4',
    date: '2026-10-09',
    title: 'AI assistant: clearer answers, charts, and a full page',
    items: [
      { text: 'Answers open with their headline figures as cards, with green or red arrows when a figure moved for the better or the worse. When a trend or a comparison is asked, the answer draws it as a chart above the table.' },
      { text: 'Tables keep their header in view, line figures up, and copy or export to Excel in one tap. Arabic answers read right to left in an Arabic typeface.' },
      { text: 'The queries behind an answer are folded under "How I got this". The expand button in the assistant\'s header opens it as a full page, with conversations and reports on the side; Dock brings it back beside the page.' },
    ],
  },
  {
    id: '2026-10-09.3',
    date: '2026-10-09',
    title: 'AI assistant: given person by person',
    items: [
      { text: 'The AI assistant is now given to specific people rather than to every administrator. Those who have it see the assistant button in the header (or in the menu on a phone); each can ask about the parts of the record they were given.' },
      { text: 'Answers no longer show what they cost.' },
    ],
  },
  {
    id: '2026-10-09.2',
    date: '2026-10-09',
    title: 'AI assistant: questions to ask next, and answers kept as reports',
    items: [
      { text: 'Under each new answer, the assistant offers two or three questions to ask next. Tap one to put it in the box, change it if you like, then send.' },
      { text: '"Save as report" keeps an answer\'s tables to run again any day, at no cost, from My reports in the assistant\'s header. A report keeps its period as it was asked — "the last 30 days" stays the last 30 days — and another range can be chosen for a run. Export Excel gives one sheet per table. Reports are personal.' },
      { text: 'Saving checks that the adjustable report returns exactly what the answer showed; when it cannot be sure, the report keeps the period it was asked with, and says so.' },
    ],
  },
  {
    id: '2026-10-09.1',
    date: '2026-10-09',
    title: 'AI assistant: ask about the record in plain words',
    items: [
      { text: 'Administrators have a new assistant button in the header (the robot, next to the chat). Ask in Arabic or English — "what were the top defects on machine 34 this month?" — and Claude answers from the factory\'s own record: inspections, defects, measurements, PT, orders and PDI, coils and suppliers, and the audit log.' },
      { text: 'Every answer shows the queries it ran, with their rows; open a result as a table with the Excel filters, or export it to Excel. The assistant only reads: it cannot change anything.' },
      { text: 'Conversations are kept per person (History in the panel). Administration → AI assistant holds the Anthropic API key (stored encrypted, never shown again), the on/off switch, the monthly cap ($50 by default; the assistant stops before it is passed) and what was spent, by day and by person.' },
    ],
  },
  {
    id: '2026-10-07.4',
    date: '2026-10-07',
    title: 'PDI and the audit log: Excel\'s filter and sort on every column',
    items: [
      { text: 'History → PDI: every column title (date, order, customer, items, by, photos, notes) has the Excel menu, over every PDI on record. Items lists every item a PDI covers, so Contains finds a PDI by any of them. Export Excel follows the column filters.' },
      { text: 'Administration → Audit log is now a table on a computer, one line per entry, with the Excel menu on every column (when, user, action, entity, field, old and new value, order, item, machine) over the whole log. Phones keep the cards.' },
      { text: 'Unticking a few values of a long list now sends "all but these", so a filter on hundreds of values stays quick and never too long to send.' },
    ],
  },
  {
    id: '2026-10-07.3',
    date: '2026-10-07',
    title: 'History: Excel\'s filter and sort on every column, over the whole record',
    items: [
      { text: 'Every History column title has the Excel menu — the figures the samples add (defects, defect %, pieces, PT, holds…) included. The values, the filter, the sort and the count cover every session on record, not only the page on screen; sorted by a column, Show the next continues in that order.' },
      { text: 'Export Excel exports what the table shows, its column filters included.' },
    ],
  },
  {
    id: '2026-10-07.2',
    date: '2026-10-07',
    title: 'Access: Excel\'s filter and sort on every column, over the whole sheet',
    items: [
      { text: 'Every Access column title has the Excel menu: sort, Text contains, and the column\'s values with how many lines carry each. The values, the filter, the sort and the count cover every line of the sheet, not only the page on screen.' },
      { text: 'Each column filter and the sort show as a chip in the filter row; Reset clears them with the rest. A column title no longer breaks in the middle of a word.' },
    ],
  },
  {
    id: '2026-10-07.1',
    date: '2026-10-07',
    title: 'Filter and sort any column, as in Excel',
    items: [
      { text: 'Every column title has a small arrow. It opens Excel\'s menu: Sort A → Z or Z → A (smallest or largest first for figures and dates), Text contains, and the column\'s values to tick, searchable, with (Select all) and how many rows carry each. Nothing changes until OK; Clear filter shows them all again.' },
      { text: 'Now on the dashboard\'s tables, the Inspections table view, Recently closed, the sessions behind a figure or a group, and the administration tables (Configuration, Users, Access sync runs, Work instructions, who read a notice). History, Access, PDI and the Audit log follow, filtering the whole record rather than the page on screen.' },
    ],
  },
  {
    id: '2026-10-06.93',
    date: '2026-10-06',
    title: 'Universal machines: up to three stages at once',
    items: [
      { text: 'Closing a session on a universal machine offers the next three stages, so a session that ran the item on three presses at the same time can tick stages 1, 2 and 3 together, each with its quantity.' },
    ],
  },
  {
    id: '2026-10-06.92',
    date: '2026-10-06',
    title: 'Universal machines: dimensions from the inspector only',
    items: [
      { text: 'On a universal machine the wizard never loads dimensions from the item setup. It starts from the dimensions typed on the last sample of the same item on the same machine, and empty the first time, so the inspector adds what the part needs.' },
      { text: 'Configuration › Machines shows a universal machine\'s dimensions as "Typed by inspector", and the switch is locked for it.' },
    ],
  },
  {
    id: '2026-10-06.91',
    date: '2026-10-06',
    title: 'Access marks the lines the order sheet got wrong',
    items: [
      { text: 'A line with an order number of 0, or with neither an item name nor an item code, shows an amber mark and a light amber row; the mark\'s tooltip says what to correct on the order sheet. The line is not hidden and nothing about it changes.' },
      { text: 'Under the table: how many of the lines on screen need checking.' },
    ],
  },
  {
    id: '2026-10-06.9',
    date: '2026-10-06',
    title: 'Photos in the chat',
    items: [
      { text: 'The chat shows each person\'s photo where it showed their initials: a direct chat in the list and at its top, the people to start a chat with, and a conversation\'s members. Someone without a photo keeps their initials.' },
      { text: 'In a group or the General channel, the sender\'s photo heads each run of their messages, beside their name.' },
    ],
  },
  {
    id: '2026-10-06.8',
    date: '2026-10-06',
    title: 'Your own photo in the account circle',
    items: [
      { text: 'The top bar shows only the round account circle, no longer your name beside it. Tap the circle for your name and role, and to add, change or remove your photo; without one, your initials show as before.' },
      { text: 'The picture is cropped to a square and made small on your device before it is sent. On a phone, the same is in the menu under Signed in as.' },
    ],
  },
  {
    id: '2026-10-06.6',
    date: '2026-10-06',
    title: 'More room for the lists: no title rows, compact rows by default',
    items: [
      { text: 'Access, Inspections and History lose their title row: the tab already names the page. Columns, Export, New Inspection, Coil Search and PDI Documents sit at the right end of the filter row; on a phone they head it.' },
      { text: 'The figures moved under the list, beside the count: "1–26 of 26 sessions · 2 open · 24 closed · By order line" on History (each still opens its sessions grouped by order line), "1–100 of 36,192 lines on the sheet" on Access.' },
      { text: 'Rows are compact everywhere, and the rows button is gone from the top bar. On a touch screen the rows stay finger-sized.' },
      { text: 'The Columns list now opens above the filter row instead of under it.' },
    ],
  },
  {
    id: '2026-10-06.5',
    date: '2026-10-06',
    title: 'History on one line a session, a calmer Inspections board, a tidier dashboard',
    items: [
      { text: 'History: the session number sits beside the order ("20480-Ph3.4  #2"), the status and its signals stay on one line (the full words in the tooltip), and Started shows the time. Far more sessions fit on the screen.' },
      { text: 'Inspections: New Inspection, Coil Search and PDI Documents in the header; one filter row with the factories and how many sessions each has open (an empty factory stays, greyed), the machine and the inspector; a header row per factory instead of boxes in boxes; a smaller Continue.' },
      { text: 'Inspections: a new "Recently closed · today" list under the board, read from History; tap a session to open it.' },
      { text: 'Dashboard: the view, the period (two dates and the presets) and the actions on one row; Arrange and Refresh are icons, Excel and PDF are under Export; the drag timeline is a slim strip behind the calendar button.' },
      { text: 'Dashboard: explanations moved behind the (i) beside each title (they still print in the PDF); every chart says the period it covers; each change says what it is against ("▼ 13.53% vs Sep"); figures on a chart no longer sit on top of one another; a long name in a pie legend wraps instead of being cut; dates read "Oct 1 – Oct 6, 2026" like the rest of the application.' },
    ],
  },
  {
    id: '2026-10-06.4',
    date: '2026-10-06',
    title: 'Tables: headers in full, the order kept in view, a clear footer',
    items: [
      { text: 'History and Access: a column title runs to two lines instead of being cut, and the item takes the width the other columns leave, so there are no gaps between columns.' },
      { text: 'The first column stays in view while a wide table scrolls sideways.' },
      { text: 'Under each list: "1–100 of 1,224 lines", Show the next 100, and Rows per page (50, 100 or 200), kept on this device.' },
      { text: 'Zeros are muted so the other figures stand out; the open session\'s row stays marked; a list that is loading shows grey rows, and one that fails says so with Try again. The row tooltip on Access is gone.' },
    ],
  },
  {
    id: '2026-10-06.3',
    date: '2026-10-06',
    title: 'History and Access: one header row, one filter row',
    items: [
      { text: 'History and Access open on one header row — the title, the figures ("26 sessions · 2 open · 24 closed", each opening its sessions), Columns and Export — and one filter row: the search, the filters used most, More filters for the rest, and Reset.' },
      { text: 'The filters in force show as chips under the row; tap a chip to drop that filter, or Clear all. Nothing is shown when no filter is set, so the list starts higher on the page.' },
      { text: 'Fit columns moved into the Columns menu. The Hold link from Inspections shows as a Disposition chip.' },
    ],
  },
  {
    id: '2026-10-06.2',
    date: '2026-10-06',
    title: 'A calmer, clearer look: tooltips, dates, badges, row density',
    items: [
      { text: 'Every date reads the same way on every device: this year with the time on a 24-hour clock ("Oct 5, 15:05"), another year with the year ("Oct 5, 2025"). Hover a date for the full timestamp.' },
      { text: 'One tooltip everywhere, in the theme\'s colours, after a short pause — the browser\'s slow grey tooltips are gone.' },
      { text: 'Badges are one line and one height and never wrap; "Defects before" is a small mark beside the status, explained on hover.' },
      { text: 'Rows: the new button beside the theme switches History and Access between Comfortable and Compact rows, kept on this device.' },
      { text: 'Secondary text is darker in the light theme so it reads clearly on every background, and the Inter font ships with the app, so a tablet without internet shows it too. Table cells lose the dotted underline: a link underlines when you point at it.' },
    ],
  },
  {
    id: '2026-10-06.1',
    date: '2026-10-06',
    title: 'History: more of the list on screen',
    items: [
      { text: 'History\'s Sessions, Open and Closed counters are small chips beside the Sessions / PDI toggle, with Export Excel and Reset all at the end of the same row; on a phone the chips keep their icon and number.' },
      { text: 'Fit columns and Columns sit beside the search box. The list starts much higher on the page.' },
    ],
  },
  {
    id: '2026-10-05.2',
    date: '2026-10-05',
    title: 'Universal machines: a final product, or stages with their quantities',
    items: [
      { text: 'Closing the first session of an item on a universal machine asks what it is: a Final product — every later session is one more inspection of a new quantity, and the quantities add up — or Stages.' },
      { text: 'A staged session ticks every stage it covered, each with its quantity: stages 1 and 2 together when the item runs on two presses at once. The quantity of a second stage starts as the first one\'s.' },
      { text: 'The dashboard counts a staged item at the quantity of its highest stage in the period, and a final product\'s sessions added up. Items closed before this change are counted as they were, on the order sheet\'s quantity.' },
      { text: 'Supervisors and administrators correct a closed session\'s choice, its stages and their quantities from Correct quantities, either way round; every change is in the audit log.' },
    ],
  },
  {
    id: '2026-10-05.1',
    date: '2026-10-05',
    title: 'A session opens to read; viewers without the ranking or the export',
    items: [
      { text: 'A session tapped from a dashboard figure, a hold, a grouped view or a chat mention opens its record in History — samples, photos and notes — instead of the screen that records a new sample. New sample is still there for an open session, for whoever records.' },
      { text: 'Roll forming raw material: the trend\'s Supplier, Thickness and Grade filters take several values at once — tick every spelling of the same supplier to read them together.' },
      { text: 'A viewer no longer sees the dashboard\'s Inspectors tab (the ranking) and can no longer export History or the PDIs to Excel. The API holds the same limits.' },
    ],
  },
  {
    id: '2026-10-04.2',
    date: '2026-10-04',
    title: 'Machines left out of the dashboard; Comparisons tidied',
    items: [
      { text: 'A machine can be left out of the dashboard (Configuration › Machines › Dashboard): it is still inspected and stays in History, but no dashboard figure counts it — for manual welding. The machines left out are named under the dashboard\'s cards.' },
      { text: 'Comparisons draws every machine of the group, each in its own colour; pick machines to compare a few. The machine names on the defects chart slant when they are long, so they no longer run into each other.' },
      { text: 'Roll forming raw material: a Grade filter on the trend, a Grade column in the table, and the table\'s header row stays in view while it scrolls.' },
    ],
  },
  {
    id: '2026-10-04.1',
    date: '2026-10-04',
    title: 'Orders straight from Access',
    items: [
      { text: 'The order sheet can now come straight from the factory\'s Access database: a small agent on a factory PC reads the orders table every 15 minutes and sends it here. The Access file is only read.' },
      { text: 'Under Administration > Data import > Access sync: the last runs (new, updated, retired, unreadable rows and why), Sync now, the agent\'s keys, and the agent to download with its steps in English and Arabic.' },
      { text: 'A line that left the Access table is retired only when the whole table arrived and read cleanly, and never more than half the lines at once; its sessions and history stay.' },
    ],
  },
  {
    id: '2026-10-03.5',
    date: '2026-10-03',
    title: 'Comparisons, rearranged',
    items: [
      { text: 'Comparisons opens on a card for each group (roll forming, welding, painting, universal): its reject rate and PPM over the period, its months and the change against the month before. Then the groups month by month with their pie. Neither moves with the group picked.' },
      { text: 'Pick a group under Machines of a group: its machines over the period, with Days, Weeks or Months picked on the chart itself, and its machines month by month beside them.' },
      { text: 'How the group\'s defects spread over its machines: a column a machine with its defects stacked, and a table of the defects, most first, with each machine\'s pieces. Tap a defect for the sessions behind it.' },
      { text: 'Roll forming raw material gains a table of every supplier, thickness and material, with the reject rate and PPM; filter its columns, or tap a row to follow it over the period. The trend picks a supplier too, and Days, Weeks or Months.' },
      { text: 'The first part tiles are no longer on Comparisons; they stay under By factory.' },
    ],
  },
  {
    id: '2026-10-03.4',
    date: '2026-10-03',
    title: 'Comparisons: roll forming raw material',
    items: [
      { text: 'Under Comparisons, Roll forming: raw material. A slicer of the roll forming machines narrows it; none picked is every one.' },
      { text: 'Reject rate and PPM by coil supplier, and by thickness with black and galvanized beside it. A session\'s pieces are shared among its coils by its samples.' },
      { text: 'Pick a thickness and black or galvanized to see it over the period: pieces made and the reject rate. Galvanized is read off the grade (+Z, +AZ, DX51D…, S350GD…); any other grade is black.' },
    ],
  },
  {
    id: '2026-10-03.3',
    date: '2026-10-03',
    title: 'Dashboard: Comparisons',
    items: [
      { text: 'By process is now Comparisons. Pick a process at the top: its reject rate, PPM, first part released and first pass released cumulative are the tiles.' },
      { text: 'Processes by month: every process\'s reject rate month by month, with a pie of the rejected pieces; the period strip does not move it. Processes over the period: the same over the period you pick, a point a day up to a month, a week up to three months, else a month.' },
      { text: 'The machines of the process picked (Roll forming 1, 2, 3…) side by side over the period, with a pie; a machine has the same colour on its line and its slice. Choose which machines to draw when there are more than six.' },
      { text: 'Comparisons has its own arrangement: an administrator moves, sizes and hides its charts under Arrange, like the other pages.' },
    ],
  },
  {
    id: '2026-10-03.2',
    date: '2026-10-03',
    title: 'Two items with one code stay apart',
    items: [
      { text: 'Two items of one order that share a code (… : N2 and … : N3 on the same machine) no longer show each other\'s notes and photos: each line keeps its own.' },
      { text: 'Their sessions no longer mark each other grey for earlier defects, and the nominals typed on one are not offered on the other.' },
      { text: 'In History and Access, the item lists show both, and picking one shows that item only; tapping an item opens its own sessions.' },
    ],
  },
  {
    id: '2026-10-03.1',
    date: '2026-10-03',
    title: 'Correct a defect picked by mistake',
    items: [
      { text: "Correct defect now changes the defect itself too: pick another of the machine's defects, or Other and describe it. Its photos stay with it; the quantity, disposition and notes are corrected in the same window." },
      { text: 'An inspector corrects a defect while the session is open; once it is closed, a supervisor or an administrator does. Every change, the defect included, is in the audit log.' },
    ],
  },
  {
    id: '2026-09-28.93',
    date: '2026-09-28',
    title: 'Dashboard: each administrator arranges their own',
    items: [
      { text: 'The dashboard as it is laid out today is now the fixed default: everyone sees it, and it no longer changes when an administrator saves.' },
      { text: 'An administrator who arranges the dashboard (moving, sizing, hiding or naming charts) now keeps it for themselves only; Default puts the default back on their board.' },
      { text: 'The colour thresholds of the figures stay one for everyone.' },
    ],
  },
  {
    id: '2026-09-28.92',
    date: '2026-09-28',
    title: 'Dashboard: exact PPM, rates to two decimals',
    items: [
      { text: 'PPM is now worked from the pieces themselves: 52 rejected on 9,130 accepted reads 5,663 PPM, where it read 5,700 because it was taken from the rate already rounded to 0.57%.' },
      { text: 'Every percentage on the dashboard reads to two decimals (0.57%, not 0.6%): reject rates, first part, shares, the changes against the period before, the chart labels and the ideas.' },
    ],
  },
  {
    id: '2026-09-28.91',
    date: '2026-09-28',
    title: 'Dashboard: first pass released cumulative',
    items: [{ text: 'The card at the top of the dashboard is now called First pass released cumulative. Its figure is unchanged: pieces rejected before release ÷ (clean sessions + those pieces), lower is better.' }],
  },
  {
    id: '2026-09-28.9',
    date: '2026-09-28',
    title: 'Access: the same window of sessions',
    items: [
      { text: 'In Access, tap an inspected line, or its order number, for every session of that order on every item and machine; Open in History keeps the old way.' },
      { text: 'Tap an item (name or code) for its sessions on every order, a machine for its latest sessions, or the Sessions or Defect pieces figure for that one line\'s sessions.' },
      { text: 'A session tapped in the window opens in History straight away.' },
    ],
  },
  {
    id: '2026-09-28.8',
    date: '2026-09-28',
    title: 'History: an order, an item or a machine at a glance',
    items: [
      { text: 'In History, tap an order number for every session of that order, on every item and machine, whatever the filters: what each line inspected, its defect pieces and defects, and a chip per session.' },
      { text: 'Tap an item (name or code) or a machine for its sessions within the filters; tap the Sessions, Open or Closed counter for the filtered sessions laid on their order lines.' },
      { text: 'A session\'s window has Whole order, This item and This machine; a session tapped in any of these views opens in History, even outside the filters.' },
    ],
  },
  {
    id: '2026-09-28.7',
    date: '2026-09-28',
    title: 'Dashboard: every number opens its sessions',
    items: [
      { text: 'Tap a number on the dashboard to see what is behind it: the order lines, their items and machines, the defects and the rejected pieces, with a link to every session.' },
      { text: 'On General: the Reject rate and PPM tiles, the Pareto bars, the pies (by factory or process, by machine, by defect, by disposition), every number of Defects by month, every row and month of By order line and By item, and the first-part tiles and the sessions-by-pieces columns.' },
      { text: 'On Details: the Pareto bars, the dispositions and the rows of Defect details. The widgets that already filter the page when tapped still do.' },
    ],
  },
  {
    id: '2026-09-28.6',
    date: '2026-09-28',
    title: 'History to Excel; PDI opens on a new record',
    items: [
      { text: 'History has Export Excel: every session the filters match, not only the page on screen, with four sheets — Sessions, Samples, Measurements and Defects — joined by each session\'s Ref. Up to 5,000 sessions a file; narrow the filters past that. Supervisors, administrators and viewers.' },
      { text: 'History\'s PDI view has Export Excel too: one row per item a PDI covers, with its drawing numbers.' },
      { text: 'The PDI button on Inspections opens a new PDI straight away; recorded PDIs are read in History, under PDI.' },
      { text: 'New PDI: the item is picked from a list of the open lines\' items, searched as you type and narrowed by the factory and machine chosen.' },
    ],
  },
  {
    id: '2026-09-28.5',
    date: '2026-09-28',
    title: 'PDI: find the order any way, nothing left out',
    items: [
      { text: 'New PDI finds an order by every word typed, in any order: "20542 ph4" finds 20542-Ph4.1-EHF-KS.' },
      { text: 'New PDI narrows the orders by factory, machine or item (any part of its name, code or drawing). An order found through an item starts with only the matching items ticked.' },
      { text: 'Cancelled lines stay out however the order sheet spells it: Cancel, Cancelled, Canceled or ملغي. A PDI cannot cover one.' },
      { text: 'Up to 100 orders are listed, and the list says when more match. Two items that share an item code are no longer merged into one.' },
    ],
  },
  {
    id: '2026-09-28.4',
    date: '2026-09-28',
    title: 'Updates reach a tablet that was asleep',
    items: [
      { text: 'The app looks for a new version when the tablet wakes or its network comes back, not only once an hour: a tablet left asleep no longer keeps an old screen, such as the old PDI order list, for hours.' },
      { text: 'New PDI: the list of an order\'s items uses more of the screen on a tablet.' },
    ],
  },
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

/**
 * Two release ids in order: the day (as text, which sorts as the calendar does), then the day's counter as a
 * number — the tenth release of a day ("…13.10") after its ninth ("…13.9"), which as text it would not be.
 */
export function compareReleaseIds(a: string, b: string): number {
  const [dayA, nA] = a.split('.')
  const [dayB, nB] = b.split('.')
  if (dayA !== dayB) return dayA < dayB ? -1 : 1
  return (Number(nA) || 0) - (Number(nB) || 0)
}

const byIdDesc = (a: Release, b: Release) => compareReleaseIds(b.id, a.id)

/** The entries newer than what this person has dismissed (or than the baseline), newest first. */
export function unseenReleases(lastSeenId: string | null | undefined, releases: readonly Release[] = RELEASES): Release[] {
  const floor = lastSeenId && compareReleaseIds(lastSeenId, RELEASE_NOTES_BASELINE) > 0 ? lastSeenId : RELEASE_NOTES_BASELINE
  return releases.filter((r) => compareReleaseIds(r.id, floor) > 0).sort(byIdDesc)
}

export function latestReleaseId(releases: readonly Release[] = RELEASES): string | null {
  return releases.length ? [...releases].sort(byIdDesc)[0].id : null
}

export function isReleaseId(id: string, releases: readonly Release[] = RELEASES): boolean {
  return releases.some((r) => r.id === id)
}
