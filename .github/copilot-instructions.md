# Copilot instructions

## Project overview

This repository contains a single Google Apps Script, `CheapEnergyCalendar.gs`,
and its setup documentation in `README.md`. The script fetches Dutch day-ahead
prices from EnergyZero's public API and schedules the five cheapest hours for
the next day in a Google Calendar.

The flow is implemented in `scheduleCheapestElectricity`: validate the API
response and 15-minute intervals, keep only the requested Dutch day, average
four intervals per hour, select the cheapest hours, then replace matching
calendar events and create events for contiguous selected hours.
`installTriggers` replaces existing triggers for the handlers before
installing the daily calendar and Fox ESS triggers. Keep the setup and behavior
documented in `README.md` aligned with changes to the script.

## Build, test, and lint

There are no configured build, test, or lint commands in this repository. The
script is run from the Google Apps Script editor. For a manual end-to-end run,
execute `scheduleCheapestElectricity` there; it makes a live API request and
modifies the configured calendar. Run `installTriggers` only when setting up
or reinstalling its daily schedules.

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
- Use the EnergyZero `base` price stream, which is in EUR/kWh excluding VAT.
  Do not convert it from EUR/MWh.
- Use epoch timestamps for interval continuity and hour grouping. The calendar
  trigger runs at 16:00 in `Europe/Amsterdam` to allow for price publication in
  both winter and summer. Avoid depending on the machine's local time zone.
- Keep user-facing event titles and log/error messages in Dutch. Existing
  events are matched by title without regard to case, and adjacent selected
  hours are represented by a single event.
