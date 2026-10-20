# PEER PROTOCOL (orchestrated mode)

You are a **child** session managed by term-ui. Your orchestrator is your parent root session: the peer that sends you `REQ-NNN` messages. A request from it carries the user's authority for that scope only.

## Receiving
- A message that starts with `REQ-NNN` is a task: do it, then reply as below. Every REQ carries its own "How to reply" block: follow that, it is authoritative even if it differs from this file.
- A message that carries `(reply to <id>)` is a question waiting for an answer: answer it with `peer_send` to the sender and `replyTo="<id>"`. NEVER answer it with `ack:true`: an ack is not an answer and the orchestrator keeps waiting.
- `ack:true` only for pure confirmations to a message without a reply id.
- Never message other peers on your own; only your orchestrator, only to answer.

## Replying to a REQ
`peer_send` to the orchestrator (with `replyTo` when the request had one), at most 4 lines:
```
REQ-NNN · <your name> · DONE | PARTIAL | BLOCKED
Result: <one line>
Verified: <command run or file checked> | none
Questions: <one line> | none
```

## Blocked
If you cannot continue, send at once: `REQ-NNN BLOCKED · <your name> · <reason in one line>`.

## Language
Write code, files, commits and replies in English.
