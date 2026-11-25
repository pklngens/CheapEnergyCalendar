# Copilot instructions

## Project overview

This repository contains two Google Apps Script files: `CheapEnergyCalendar.gs`
manages calendar events, and `FoxBatteryManager.gs` independently plans and
syncs a battery schedule. Both use EnergyZero's Dutch day-ahead price API, but
the battery manager does not consume calendar events.

The calendar flow is implemented in `scheduleCheapestElectricity`: validate
the API response and 15-minute intervals, keep only the requested Dutch day,
average four intervals per hour, select the cheapest hours, then replace
matching calendar events and create events for contiguous selected hours. The
battery flow is implemented in `syncFoxESSForTomorrow`. Keep the calendar and
battery triggers separate: `installCalendarTrigger` manages only the calendar
handler, while `installFoxBatteryTrigger` manages only the battery handler.
Keep the setup and behavior documented in `README.md` aligned with the scripts.
When changing scheduling behavior or tuning constants, update the matching
README behavior description and constants summary in the same change.

## Build, test, and lint

There is no configured build or lint command. The scripts are run from the
Google Apps Script editor. The offline battery-plan tests use Node.js 18 or
later and can be run with `node --test test-fox-battery-plan.js`; they use
Node's built-in test runner and need no npm dependencies. For a manual calendar
run, execute `scheduleCheapestElectricity`; it makes a live API request and
modifies the configured calendar. `syncFoxESSForTomorrow` makes live Fox ESS
API calls and modifies the battery scheduler. Run each install function only
when setting up or reinstalling its respective trigger.

## Code conventions

- Keep calendar settings in the constants at the top of
  `CheapEnergyCalendar.gs` and Fox ESS settings in `FoxBatteryManager.gs`.
  `SCRIPT_TIME_ZONE` is a required Script Property read independently by both
  files; do not make either script depend on the other's constants or helpers.
- The code uses Google Apps Script services (`UrlFetchApp`, `CalendarApp`,
  `ScriptApp`, and `Logger`) directly; the script is not structured as a
  Node.js module.
- Preserve the validation-before-calendar-mutation flow. Reject missing,
  malformed, non-finite, or discontinuous API data, and require exactly four
  quarter-hour prices per hour before deleting or creating events.
- Use the EnergyZero `base` price stream, which is in EUR/kWh excluding VAT.
  Do not convert it from EUR/MWh.
- The battery manager reads SoC via `/op/v0/device/real/query` with
  `{sn: deviceSN, variables: ['SoC']}` and validates the returned percentage.
  It uses a cheapest contiguous sliding window, an eight-quarter 10%-to-100%
  baseline at 1200 W, and a 1.20 discharge multiplier. At 85% SoC or above,
  skip charging but use a hypothetical cheapest eight-quarter window for the
  profitability reference.
- Merge adjacent 15-minute battery intervals with identical modes. Compare the
  final group count against the device-reported `maxGroupCount` and do not write
  if it exceeds the limit.
- Use epoch timestamps for interval continuity and hour grouping. The calendar
  trigger runs at 16:00 and the battery trigger at 23:00 in
  `Europe/Amsterdam` to allow for price publication and overnight scheduling.
  The time zone comes from the `SCRIPT_TIME_ZONE` Script Property; reinstall
  both triggers after changing it. Avoid depending on the machine's local time
  zone.
- The battery scheduler must reject the autumn repeated-hour DST transition
  because local schedule groups cannot distinguish the repeated hour. Preserve
  the existing validation that prevents overwriting the Fox ESS schedule when
  the plan is invalid or exceeds `maxGroupCount`.
- The read-only `test-foxess-scheduler-get.ps1` and replacement/restore
  `test-foxess-scheduler-replace-restore.ps1` scripts are optional live Fox
  ESS tools. Keep replacement tests explicitly guarded, preserve restore
  behavior, and document that they can cause charging.
- All user-facing alerts, thrown errors, and log strings in this codebase must
  be written in English. Existing calendar events are matched by title without
  regard to case, and adjacent selected hours are represented by a single
  event.
