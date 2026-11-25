# Cheap Energy Calendar

This Google Apps Script project contains two independent schedules:

- `CheapEnergyCalendar.gs` creates calendar events for the five cheapest
  electricity hours tomorrow.
- `FoxBatteryManager.gs` plans and uploads tomorrow's Fox ESS battery schedule
  from live battery charge and day-ahead EnergyZero prices.

The battery manager does not read or depend on calendar events.

Both scripts use the `base` price stream from the
[EnergyZero public API](https://public.api.energyzero.nl/public/v1/prices).
It is the market price in EUR/kWh excluding VAT, not a complete supplier bill.

## Calendar script

`scheduleCheapestElectricity` validates the API response for exactly four
15-minute prices per hour in tomorrow's Dutch local day, averages those prices,
and selects the five cheapest hours.

Existing `Goedkope stroom` events for tomorrow are case-insensitively matched
and replaced. Adjacent selected hours become one event. Events are pale green;
an event containing a negative hourly average is blue.

The calendar update runs at approximately 16:00 in the configured
`SCRIPT_TIME_ZONE`. This allows for EnergyZero publication around 14:00 UTC in
both winter and summer. Missing, malformed, non-finite, incomplete, or
discontinuous price data stops the update before any calendar events are
deleted or created.

## Battery script

`syncFoxESSForTomorrow` fetches tomorrow's quarter-hour prices and the current
SoC from the Fox ESS API.

The manager:

- calculates required charging time from SoC, using eight quarter-hours as the
  10%-to-100% baseline at 1200 W;
- schedules the primary charge in the cheapest contiguous window from 00:00 to
  07:00;
- uses a hypothetical cheapest eight-quarter overnight window as the discharge
  reference when SoC is at least 85%, even though it skips the primary charge;
- looks for a six-quarter (90-minute) top-up in the cheapest window from 10:00
  to 15:00, and schedules it only when the average price from 16:00 to 21:00 is
  at least 1.20 times the candidate top-up window's average price;
- sets **ForceCharge** for each scheduled charging window;
- uses all-in consumer prices, adding the optional supplier fee and VAT to the
  wholesale price and energy tax. The base discharge threshold is the higher
  of the reference price multiplied by its multiplier and the reference price
  plus 0.045 EUR/kWh;
- applies these thresholds to non-charging intervals:

  | Time | Condition | Threshold |
  | --- | --- | --- |
  | Before 17:00 on weekdays | Midday top-up scheduled, or SoC at least 85% during the 10:15 re-evaluation | Base threshold using the overnight reference and 1.20 multiplier |
  | Before 17:00 on weekdays | No midday top-up scheduled, except when SoC is at least 85% during the 10:15 re-evaluation | Higher of the base threshold using the overnight reference and 1.35 multiplier, or 80% of the 16:00 to 21:00 average price |
  | Before 15:00 on weekends | Weekend | Base threshold using the overnight reference and 1.28 multiplier |
  | From the evening start (17:00 weekdays, 15:00 weekends) | Midday top-up scheduled | Higher of the base threshold using the top-up reference and 1.20 multiplier, or 85% of the 16:00 to 21:00 average price |
  | From the evening start (17:00 weekdays, 15:00 weekends) | SoC at least 85% during the 10:15 re-evaluation | Higher of 0 EUR/kWh or 85% of the 16:00 to 21:00 average price |
  | From the evening start (17:00 weekdays, 15:00 weekends) | No midday top-up scheduled, except when SoC is at least 85% during the 10:15 re-evaluation | Higher of the base threshold using the overnight reference and 1.20 multiplier, or 85% of the 16:00 to 21:00 average price |

  At or above the applicable threshold, the mode is **SelfUse**; below it,
  the mode is **Backup**. Scheduled charging intervals remain **ForceCharge**.
- smooths isolated single-quarter mode changes: **SelfUse** between
  **Backup** intervals becomes **Backup**, and **Backup** between contiguous
  **SelfUse** intervals becomes **SelfUse**, even if its price is negative;
- merges adjacent intervals with identical modes;
- rejects the plan if the merged group count exceeds Fox ESS's reported
  `maxGroupCount`, and does not replace the existing schedule.

The fixed six-quarter top-up in the 23:00 plan is evaluated independently of
the 85% primary-charge skip. The 10:15 re-evaluation instead uses live SoC and
may calculate zero required quarters. At or above 85%, it treats the battery as
sufficiently charged for discharge thresholds without scheduling a midday
top-up; the log still reports the top-up as not scheduled.
An additional trigger runs around 10:15, reads live SoC, and re-evaluates
today's cheapest qualifying charge window from 10:30 to 15:00. It updates the
schedule for the rest of the day. Price windows use local clock times; on the
autumn clock change, repeated quarter-hour prices are averaged by local time
before planning so the schedule contains no duplicate clock slots.

`SelfUse` relies on the existing HomeWizard P1 zero-export setup. The battery
manager does not communicate with the P1 meter.

## Setup

1. Create a project at [Google Apps Script](https://script.google.com/).
2. Copy `CheapEnergyCalendar.gs` and `FoxBatteryManager.gs` into the project.
3. Add the following Script Properties under **Project Settings > Script
   Properties**:

   | Property | Required for | Purpose |
   | --- | --- | --- |
   | `SCRIPT_TIME_ZONE` | Both scripts | Local time zone; use `Europe/Amsterdam` for Dutch time. |
   | `CALENDAR_NAME` | Calendar script | Exact calendar name, for example `Huis`. |
   | `FOX_API_KEY` | Battery manager | Fox ESS API key. |
   | `FOX_DEVICE_SN` | Battery manager | Fox ESS inverter serial number. |
   | `FOX_FD_POWER_W` | Battery manager | Supported schedule power in watts, for example `1200` for the MQ2200-M-AC setup. |
   | `ENERGY_TAX_EUR_KWH` | Battery manager (optional) | Energy tax including VAT in EUR/kWh, default `0`. |
   | `SUPPLIER_FEE_EUR_KWH` | Battery manager (optional) | Supplier purchase fee excluding VAT in EUR/kWh, default `0`. |
   | `VAT_PERCENTAGE` | Battery manager (optional) | VAT percentage, for example `21`; default `0`. |

4. Set `CALENDAR_NAME` in Script Properties to the exact calendar name. There
   must be exactly one calendar with that name.
5. Save the project and authorize it. The scripts require Google Calendar
   access, external API access, and Script Property access as applicable.

## Install and run

Run the installer functions once per schedule:

| Function | Action | Default time |
| --- | --- | --- |
| `installCalendarTrigger` | Installs or replaces only the calendar trigger | Approximately 16:00 |
| `installFoxBatteryTrigger` | Installs or replaces both battery triggers | Approximately 10:15 and 23:00 |

For a manual calendar run, execute `scheduleCheapestElectricity`. For a manual
battery run, execute `syncFoxESSForTomorrow` to plan tomorrow or
`syncFoxESSForMidday` to re-evaluate today's remaining midday window. Manual runs
may update the target calendar or Fox ESS schedule immediately.

The two triggers are independent and should be installed separately. Re-run the
matching installer after changing a trigger hour in the script. Re-run both
installers after changing `SCRIPT_TIME_ZONE`, because both triggers must be
recreated in the new zone.

Google Apps Script time-based triggers run approximately at the configured hour,
not necessarily at an exact minute.

## Script configuration

Calendar constants, event text, the 16:00 trigger hour, and the five-hour
selection are at the top of `CheapEnergyCalendar.gs`.

Battery constants, including the 23:00 trigger hour, 15-minute interval,
eight-quarter baseline, 85% SoC skip threshold, 1.20 discharge multiplier,
1.28 weekend morning multiplier, 1.35 weekday morning multiplier when no
midday top-up is scheduled, 17:00 weekday and 15:00 weekend evening starts,
six-quarter midday top-up duration, and 1.20 midday spread multiplier, are at
the top of `FoxBatteryManager.gs`. Put
supplier-specific taxes, fees, and VAT in the optional Script Properties rather
than source control.

The calendar title and description templates are in `EVENT_TEXT`. If localized,
preserve the `{hours}`, `{minPrice}`, `{maxPrice}`, and `{average}` placeholders.

## Battery plan tests

Run `node --test test-fox-battery-plan.js` with Node.js 18 or later for offline
planning checks. These tests use simulated data and do not contact Fox ESS.

## Fox ESS API tests

Run `test-foxess-scheduler-get.ps1` for a read-only Scheduler V3 capability
check.

`test-foxess-scheduler-replace-restore.ps1` captures the current groups,
replaces them with one temporary `ForceCharge(BAT)` group, and restores the
captured groups. It prompts for a safe device-local time window and requires
typing `REPLACE`.

The test window can cause charging. If the restore request fails or the script
is interrupted, restore the saved plan manually in Fox ESS Cloud.
