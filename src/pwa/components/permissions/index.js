import { detailShell, block } from '../settings-surface/detail-shell.js';
import { settings } from '../../state/settings.js';
import { renderGroupsBlock } from './groups.js';
import { renderPendingBlock } from './pending.js';
import { renderGrantsBlock } from './grants.js';

// Settings > Permissions. Three blocks — Groups, Pending classifications, Grants — each owned
// by its own module; this file is only the shell that mounts them, so no block's markup ever
// grows into the surface that hosts it.

export function renderPermissions(mount) {
  const body = detailShell(mount, 'Permissions',
    'Permission groups are the only thing that grants an action anything. Editing one is re-linted before it applies, and every change is recorded in the group’s history.');

  // First block on the page because it's the one thing here that isn't about actions: it
  // governs what YOU can run from the composer, with no group and no approval card between
  // the command and the shell.
  const shellSection = block(body, 'Shell commands', `
    <div class="settings-segmented" data-role="shell-commands">
      <button type="button" data-value="off">Off</button>
      <button type="button" data-value="on">On</button>
    </div>
    <p class="settings-note">Lets <code>!command</code> in a session composer run in that session's working directory, as you — no allowlist, no approval card. Output shows in the transcript and rides into your next message so Claude sees it. Anyone who can reach this PWA can use it.</p>
  `);
  function paintShell() {
    const on = settings.get().shellCommands;
    for (const btn of shellSection.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === (on ? 'on' : 'off'));
    }
  }
  shellSection.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) settings.setShellCommands(btn.dataset.value === 'on');
  });
  paintShell();
  const unsubShell = settings.subscribe(paintShell);

  const groupsSection = block(body, 'Permission groups', '<div class="permgroup-list"></div>');
  const pendingSection = block(body, 'Pending classifications',
    '<div class="perm-pending-list"></div>');
  // The subtitle is the single most load-bearing sentence on this page, so it renders inline,
  // always, never behind a tooltip. It has to be true of the rows directly beneath it: Ship 2
  // confined action-bound calls away from global and project scope, but NOT away from action
  // scope — `scopesFor` still consults actionsStore for an action-bound call, and those
  // `action · <name>` rows are listed (and revocable) right here. Claiming they never reach an
  // action was wrong about the very rows it sat above.
  const grantsSection = block(body, 'Grants', `
    <p class="perm-grants-subtitle"><strong>Global and project grants reach sessions and skills only</strong> — never an action. An <code>action · name</code> row is the exception: it was installed by an approved action proposal and it does reach that one action, on top of the groups the action declares. Nothing here can be added from this page; a group is the only door for new action permissions.</p>
    <div class="perm-grants-list"></div>
  `);

  const groupsApi = renderGroupsBlock(groupsSection.querySelector('.permgroup-list'));
  const unmountPending = renderPendingBlock(pendingSection.querySelector('.perm-pending-list'));
  const unmountGrants = renderGrantsBlock(grantsSection.querySelector('.perm-grants-list'),
    { promoteToGroup: groupsApi.promote });
  return () => { unsubShell(); groupsApi.unmount(); unmountPending(); unmountGrants(); };
}
