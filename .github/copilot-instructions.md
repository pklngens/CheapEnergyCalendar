# Copilot instructions

## Project overview

This repository contains a single Google Apps Script, `CheapEnergyCalendar.gs`,
and its setup documentation in `README.md`. The script fetches Dutch day-ahead
prices from Energy-Charts and schedules the five cheapest hours for the next
day in a Google Calendar.

The flow is implemented in `planGoedkopeStroom`: validate the API response and
15-minute intervals, average four intervals per hour, select the cheapest
hours, then replace matching calendar events and create events for contiguous
selected hours. `installDagelijkseTrigger` replaces any existing trigger for
the handler before installing a daily trigger. Keep the setup and behavior
documented in `README.md` aligned with changes to the script.

## Build, test, and lint

There are no configured build, test, or lint commands in this repository. The
script is run from the Google Apps Script editor. For a manual end-to-end run,
execute `planGoedkopeStroom` there; it makes a live API request and modifies the
configured calendar. Run `installDagelijkseTrigger` only when setting up or
reinstalling its daily schedule.

## Code conventions

- Keep deployment settings together in the constants at the top of
  `CheapEnergyCalendar.gs`, including calendar name, API URL, interval length,
  time zone, trigger hour, and number of selected hours.
- The code uses Google Apps Script services (`UrlFetchApp`, `CalendarApp`,
  `ScriptApp`, and `Logger`) directly; the script is not structured as a
  Node.js module.
- Preserve the validation-before-calendar-mutation flow. Reject missing,
  malformed, non-finite, or discontinuous API data, and require exactly four
  quarter-hour prices per hour before deleting or creating events.
- API prices are in EUR/MWh. Convert to EUR/kWh by dividing by 1,000 only when
  formatting the event descriptions.
- Use epoch timestamps for interval continuity and hour grouping; the trigger
  uses `Europe/Amsterdam`. Avoid depending on the machine's local time zone.
- Keep user-facing event titles and log/error messages in Dutch. Existing
  events are matched by title without regard to case, and adjacent selected
  hours are represented by a single event.
