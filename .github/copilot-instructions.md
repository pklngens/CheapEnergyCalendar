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
For every Script Property change, update and verify the README property matrix
against the code's requiredness, defaults, accepted values, and validation.

## Build, test, and lint

There is no configured build or lint command. The scripts are run from the
Google Apps Script editor. The offline battery-plan tests use Node.js 18 or
later and can be run with `node --test test-fox-battery-plan.js`; they use
Node's built-in test runner and need no npm dependencies. For a manual calendar
run, execute `scheduleCheapestElectricity`; it makes a live API request and
modifies the configured calendar. `syncFoxESSForTomorrow` makes live Fox ESS
API calls and modifies the battery scheduler. Run each install function only
when setting up or reinstalling its respective trigger.
On Windows, if `node` is not available on `PATH` after installation, run the
tests with `& 'C:\Program Files\nodejs\node.exe' --test test-fox-battery-plan.js`.

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
  Use the configurable 17:00–22:00 evening benchmark defined by
  `FOX_EVENING_BENCHMARK_START_HOUR` and `FOX_EVENING_BENCHMARK_END_HOUR` for
  midday top-up eligibility and discharge threshold floors.
  It calculates the full-charge quarter count from the required
  `FOX_BATTERY_CAPACITY_WH`, configured `FOX_FD_POWER_W`, 90% charge efficiency,
  and 15-minute interval duration. Calculate active `requiredQuarters` directly
  from the remaining SoC to 100%, without scaling by `FOX_MIN_SOC_ON_GRID`.
  This optional property defaults to 10, must be an integer from 10 through
  100 when configured, and is sent to Fox ESS as `minSocOnGrid`. At or above
  85%, skip charging and use the hypothetical full-charge window, whose size is
  based on `FOX_MIN_SOC_ON_GRID`, as the profitability reference. Preserve
  sensible defaults in `createFoxBatteryPlan` for tests that omit the new
  options.
  Treat capacity as the connected battery's rated watt-hours (2110 Wh for the
  documented setup), separate from the inverter charge power, and validate it
  as a positive finite number before planning.
- If `ALERT_EMAIL` is set, schedule-update failures send a failure notification;
  notification errors must never replace the original schedule error.
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
