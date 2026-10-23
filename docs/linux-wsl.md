# Running on Linux / WSL2

On Linux the same `install/install.sh` installs a systemd **user** service (`~/.config/systemd/user/outpost.service`) instead of a LaunchAgent, and enables lingering so it runs from boot rather than from your first login. Logs go to the journal: `journalctl --user -u outpost -f`. Also install `expect` (`sudo apt install expect`) — the PWA's Claude / MCP login flows drive the CLI through it.

On Windows, run Outpost inside a WSL2 distro (Ubuntu is the tested path):

1. **Turn on systemd.** Add this to `/etc/wsl.conf`, then run `wsl.exe --shutdown` from Windows and reopen the distro:

   ```ini
   [boot]
   systemd=true
   ```

2. **Keep your repos in the Linux filesystem** (`~/code/...`), not under `/mnt/c`. Git and worktree operations across that boundary are an order of magnitude slower.

3. **Install** Node 22+, `claude`, `gh` (optional with a `GITHUB_TOKEN` in `~/.outpost/.env`), and `expect` inside the distro, log in to `claude`, then clone and run `install/install.sh` as in the README.

4. **Keep the distro alive.** WSL stops a distro shortly after its last terminal closes, systemd services included, and nothing starts it at Windows login. Register a logon task from PowerShell that holds it open:

   ```powershell
   $a = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu --exec sleep infinity"
   $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -Hidden
   Register-ScheduledTask -TaskName "Outpost WSL" -Action $a -Trigger $t -Settings $s
   ```

5. **Open `http://localhost:8080`** in a Windows browser. WSL2 forwards Windows `localhost` to the distro, so nothing else is needed for local use.

For remote access, run Tailscale **inside the distro** (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`), not just on Windows — under WSL2's default NAT networking the Windows node's `100.x` address doesn't reach the distro. The distro becomes its own tailnet machine; follow [remote access](remote-access.md) from step 2, after `sudo tailscale set --operator=$USER` so `tailscale cert` can run without root.

To uninstall: `systemctl --user disable --now outpost && rm ~/.config/systemd/user/outpost.service`.
