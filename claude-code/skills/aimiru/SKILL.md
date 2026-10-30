---
name: aimiru
description: The Aimiru routine. Use it at the start of every session, and before you spend money, send a message, share something, book, delete anything or sign in for the person. It says when to check with Aimiru, what to do while a question to the person stays open, and how to record what happened.
metadata:
  aimiru-routine-version: "6"
---

# The Aimiru routine

You act for a person who uses Aimiru, the home for their agents. Aimiru holds the rules they decided once, answers for them when a rule covers what you are about to do, and when no rule does, asks them on their phone when they have one set up. Follow these steps in every session:

1. Aimiru keeps your person's rules for all their agents and asks them when no rule covers a step.
2. Before you spend, send, share, book, delete or sign in, call check and do what it says, unless Aimiru for Claude Code, Codex, OpenClaw or Hermes is installed and checks your steps.
3. When Aimiru asks your person, the question stays open: carry on with other work, then try exactly that step again.
4. If Aimiru does not answer, do not spend, send, share, book, delete or sign in.
5. If Aimiru for Claude Code, Codex, OpenClaw or Hermes checks that step, it goes through once your person says yes; if you called check yourself, call get_answer, and on allowed take that step without checking it again.
6. An Aimiru connector that checks each step (Aimiru for Claude Code, Codex, OpenClaw or Hermes) checks it before it runs: take the step, and do not call check or request_approval for it.
7. When Aimiru refuses a step, tell your person in Aimiru's words and do not reach the same result another way.
8. While pause_status says paused, do not act: Aimiru holds or refuses your next step until your person resumes, and then you carry on where you were.
9. To read the answer to a question that stays open, call get_answer: it never asks your person again.
10. After you act, call record with the action_id from check and the outcome.
11. Use request_approval only when your person told you to ask them first; otherwise check decides, as above.
12. An answer with person_quiet_until means your person is not alerted until then: carry on, and try the step again after that time.

Aimiru's tools (check, request_approval, get_answer, record, pause_status) come from the Aimiru server the person connected for you.

If this skill came with an Aimiru connector that checks each step (Aimiru for Claude Code, Codex, OpenClaw or Hermes), do not call check or request_approval for those steps, even if you have those tools: take the step, and when Aimiru holds or refuses it, tell the person in Aimiru's words and do not try to reach the same result another way.

If you have neither the tools nor an Aimiru connector, tell the person that Aimiru is not connected for you, and do not spend money, send messages, share, book, delete or sign in until it is.

Do what Aimiru says: allow means go ahead; ask means the question stays open with the person, so carry on with other work and try exactly that step again later (a step your Aimiru connector checks goes through once they say yes; after a check you called yourself, read the answer with get_answer, and on allowed take that step without checking it again); deny means do not act and tell the person why in Aimiru's words.
