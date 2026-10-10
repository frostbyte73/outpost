// Single source of truth for every bindable command's id, owning surface,
// label/description, and default binding. Shared by the keymap registry, the
// handlers, and the settings page. Pure data — no DOM, no store reads.
//
// NOTE: session.archive defaults to mod+shift+e (not mod+shift+a): Chrome
// reserves ⌘⇧A, so the archive shortcut was rebound to ⌘⇧E (commit fe6cddd).

export const KEYMAP_COMMANDS = [
  { id: 'shell.togglePalette', surface: 'shell', label: 'Toggle command palette', description: 'Open or close the ⌘K palette.', defaultBinding: 'mod+k' },
  { id: 'shell.toggleSidebar', surface: 'shell', label: 'Toggle sidebar', description: 'Collapse or expand the sidebar.', defaultBinding: 'mod+b' },
  { id: 'shell.focusFilter', surface: 'shell', label: 'Focus list filter', description: 'Focus the current list column filter input.', defaultBinding: 'mod+f' },
  { id: 'shell.jump.cockpit', surface: 'shell', label: 'Jump to Cockpit', description: 'Switch to the Cockpit surface.', defaultBinding: 'mod+1' },
  { id: 'shell.jump.tracked', surface: 'shell', label: 'Jump to Tracked', description: 'Switch to the Tracked surface.', defaultBinding: 'mod+2' },
  { id: 'shell.jump.sessions', surface: 'shell', label: 'Jump to Sessions', description: 'Switch to the Sessions surface.', defaultBinding: 'mod+3' },
  { id: 'shell.jump.schedules', surface: 'shell', label: 'Jump to Schedules', description: 'Switch to the Schedules surface.', defaultBinding: 'mod+4' },
  { id: 'shell.jump.skills', surface: 'shell', label: 'Jump to Skills', description: 'Switch to the Skills surface.', defaultBinding: 'mod+5' },
  { id: 'shell.jump.runs', surface: 'shell', label: 'Jump to Runs', description: 'Switch to the Runs surface.', defaultBinding: 'mod+6' },
  { id: 'shell.jump.settings', surface: 'shell', label: 'Jump to Settings', description: 'Switch to the Settings surface.', defaultBinding: 'mod+7' },
  { id: 'session.promoteToJob', surface: 'session', label: 'Promote session to job', description: 'Promote the current session to a tracked job.', defaultBinding: 'mod+shift+p' },
  { id: 'session.archive', surface: 'session', label: 'Archive session', description: 'Archive the current session.', defaultBinding: 'mod+shift+e' },
  { id: 'palette.newProject', surface: 'palette', label: 'New project (step 1)', description: 'Open the add-project sheet from palette step 1.', defaultBinding: 'mod+o' },
  { id: 'palette.back', surface: 'palette', label: 'Back to step 1', description: 'Return to the palette Where step.', defaultBinding: 'mod+shift+d' },
  { id: 'palette.cycleModel', surface: 'palette', label: 'Cycle model', description: 'Cycle the launch model chip.', defaultBinding: 'mod+m' },
  { id: 'palette.launchSchedule', surface: 'palette', label: 'Launch as schedule', description: 'Launch the composed prompt as a schedule.', defaultBinding: 'mod+shift+s' },
  { id: 'palette.launchSession', surface: 'palette', label: 'Launch session', description: 'Launch the composed prompt as a session.', defaultBinding: 'mod+enter' },
  { id: 'palette.launchTrack', surface: 'palette', label: 'Launch as tracked job', description: 'Launch the composed prompt as a tracked job.', defaultBinding: 'mod+shift+enter' },
  { id: 'diff.primaryAction', surface: 'diff', label: 'Run primary action', description: 'Run the diff overlay primary action.', defaultBinding: 'mod+enter' },
  { id: 'diff.regenerate', surface: 'diff', label: 'Regenerate commit message', description: 'Regenerate the drafted commit message.', defaultBinding: 'mod+r' },
  { id: 'diff.comment', surface: 'diff', label: 'Comment on hovered row', description: 'Open a comment on the hovered diff row (when not typing).', defaultBinding: 'c' },
  { id: 'cockpit.next', surface: 'cockpit', label: 'Next row', description: 'Move the cockpit highlight down.', defaultBinding: 'j' },
  { id: 'cockpit.prev', surface: 'cockpit', label: 'Previous row', description: 'Move the cockpit highlight up.', defaultBinding: 'k' },
  { id: 'cockpit.toggle', surface: 'cockpit', label: 'Expand row', description: 'Open or close the highlighted row.', defaultBinding: 'space' },
  { id: 'cockpit.action', surface: 'cockpit', label: 'Open what needs you', description: 'Open only what the highlighted row is waiting on.', defaultBinding: 'a' },
  { id: 'cockpit.reply', surface: 'cockpit', label: 'Reply', description: 'Focus the open row’s message box.', defaultBinding: 'r' },
  { id: 'cockpit.archive', surface: 'cockpit', label: 'Archive session', description: 'Archive the highlighted manual session.', defaultBinding: 'e' },
  { id: 'cockpit.open', surface: 'cockpit', label: 'Open full view', description: 'Open the highlighted row in Tracked or Sessions.', defaultBinding: 'enter' },
  { id: 'cockpit.collapse', surface: 'cockpit', label: 'Collapse', description: 'Leave the message box, or collapse the open row.', defaultBinding: 'escape' },
  { id: 'cockpit.nextNeedsYou', surface: 'cockpit', label: 'Next that needs you', description: 'Jump to the next row waiting on you.', defaultBinding: 'n' },
];

export const DEFAULT_BINDINGS = Object.fromEntries(
  KEYMAP_COMMANDS.map((c) => [c.id, c.defaultBinding]),
);
