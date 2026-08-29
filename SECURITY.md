# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email **soni.mil2001@gmail.com** with
the details (or use GitHub's private vulnerability reporting on this repo if enabled). You'll get a
response as soon as possible, normally within a few days.

## Scope notes for researchers

- The desktop renderer reaches orchestration only through a narrow `contextBridge` API. The utility
  process must not bind a TCP listener. Provider helper processes use a randomized owner-only named
  pipe/Unix socket; access by another local user is a vulnerability.
- Packaged-app API keys use the operating-system credential store and are write-only through desktop
  IPC (`configured` booleans out, never values). Any path that echoes a stored secret back — IPC event,
  log line, argv visible in `ps` — is a vulnerability.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions. Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.

