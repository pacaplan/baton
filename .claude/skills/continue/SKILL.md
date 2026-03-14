---
description: >
  Signal baton to advance to the next workflow step. Use when the user says
  "continue", "next step", "advance", "move on", or invokes /continue.
allowed-tools: Bash
---

# Continue

Signal the baton orchestrator that the current step is complete and it should advance to the next step.

## Steps

### Step 1: Write the signal file

```bash
echo '{"action":"continue"}' > .baton-signal
```

### Step 2: Confirm

Tell the user:

> Baton signal sent. This session will close and baton will start the next workflow step.

Do not take any further actions after this.
