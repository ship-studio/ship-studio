# Pause Pomodoro after app exit

Approved behavior: closing the application, including Cmd+Q and the current red-close exit flow, restores a paused timer on the next launch. Minimizing or switching apps keeps the countdown running. Resume is explicit using the existing button.

Persist a paused checkpoint on each timer state change; retain the live state in window-local module memory across workspace remounts. A fresh process restores only the checkpoint. Legacy running records restore paused using their saved remaining seconds. No dependency on asynchronous shutdown callbacks. Checkpoint precision is approximately one second while mounted; if the timer UI is unmounted, the restart checkpoint is its last saved value. Multi-window synchronization is outside this change.

Verify paused restoration, legacy records, manual resume and uninterrupted workspace remounts. Run all repository CI gates.
