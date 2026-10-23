# limit-resume

A mod for Claude Code that continues an interrupted session by itself once
your subscription usage limit resets. Before the limit runs out it asks Claude
to save a short checkpoint (goal, what is done, what remains, the next step),
and after the reset it sends that same session a request to carry on, with
the checkpoint attached.

It works in the Code tab of the Claude desktop app and in an interactive
terminal session. Headless runs (`claude -p`, SDK scripts, bots, timers) are
never touched.

## Install

In a terminal session:

```
/plugin install limit-resume --marketplace ivbala1/limit-resume
```

Answer `y` to add the marketplace and pick the user scope. New sessions get
the mod on their own; in a session that is already open, send
`/reload-plugins`, then `/limit-resume status` to see it loaded.

## What it does

- **A budget line on every prompt.** Each of your messages carries one line
  for Claude: how much of the five-hour and weekly windows is used, when each
  resets, and a forecast from the pace of the last hour of this session
  ("lasts until the reset" or "runs out around 14:05"). A short rule on how to
  spend the rest is added only when the forecast falls short or a window is at
  70% or more.
- **A checkpoint before the limit.** From 90% Claude is asked once to call the
  mod's `checkpoint` tool with six short fields and two flags: `continuation`
  (`auto`: can go on alone, `owner`: waits for you, `done`: finished) and
  `verifyFirst` (the last action may have run partly). Only the latest
  checkpoint of the session is kept, in the plugin's own store. No transcript,
  no command output.
- **A continuation after the reset.** When the limit is hit, the mod waits
  for the reset time the engine reports, plus a minute, and sends the session
  a request to continue. The request always starts with "check how the last
  action ended and do not repeat it". A checkpoint saved before your last own
  message is not attached: it describes an older task. A task marked `owner`
  or `done` is not continued.
- **Retries with a limit.** A continuation the engine refuses from its queue
  is retried with backoff, three attempts at most. A refusal because you
  stopped the session is final.
- **You stay in charge.** Typing in the prompt box, sending anything else,
  editing a message, `/clear` or `/limit-resume off` cancels the wait. The mod
  never interrupts running commands or subagents and never changes
  permissions.

All open sessions that hit the limit continue at once after the reset; there
is no queue.

## Settings

Set them with `/plugin configure limit-resume@limit-resume`, or in
`settings.json`; unset options keep the defaults below:

```json
{
  "pluginConfigs": {
    "limit-resume@limit-resume": {
      "options": { "language": "en", "timeZone": "", "reserveFor": "", "economyHint": "" }
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | `en` or `ru`: the mod's messages and its notes to Claude |
| `timeZone` | system zone | IANA zone for clock times, such as `Europe/Berlin` |
| `reserveFor` | empty | Keep the last part of the limit for marked sessions (see below); empty turns it off |
| `economyHint` | empty | Your own advice added to the spending rule, such as "hand scouting to a cheaper model" |

### Reserve

If something of yours must always have budget left (an assistant you talk to,
a scheduled job), set `reserveFor` to its name as it reads in "the rest is
kept for ...". Then from 97% of the five-hour window or 99% of the week an
ordinary session saves its checkpoint, ends its turn and waits for the reset,
and only sessions marked with `/limit-resume reserve` keep working. The
reserve holds right up to the reset, and a session paused by the weekly
reserve waits for the weekly reset even if the five-hour one comes first.
Turning the reserve off releases a paused session within a minute. The
reserve is approximate: percentages lag behind real usage and running
commands are not stopped.

Within 15 minutes of a window's reset the spending rule tells Claude it no
longer needs to economise on that window.

## Commands

| Command | Effect |
| --- | --- |
| `/limit-resume status` | Version, session and state |
| `/limit-resume on` / `off` | Turn the mod on or off in this session; the choice is kept |
| `/limit-resume arm` | Wait for the reset in a session that has already stopped |
| `/limit-resume at 02:40` | Wait until that time in your zone, or give an ISO date with an offset |
| `/limit-resume checkpoint` | Show the latest checkpoint |
| `/limit-resume reserve` / `reserve off` | Let this session spend the reserve, or stop that |

These commands are answered by the mod itself, with no model call.

## Limits

- The computer has to be awake and the app or terminal session open; the mod
  does not start a closed app.
- Usage numbers come from the engine without network calls and are the last
  estimate it received. A large request or parallel subagents can run out the
  rest before the checkpoint is saved.
- A new session does not reset the shared limit, and the mod does not compact
  context, open new chats or switch models.
- Saving the checkpoint and ending the turn rely on Claude following the
  instruction.

## Development

```
claude plugin validate --strict .
claude plugin test .
```

MIT License.
