# Cheap Energy Calendar

A Google Apps Script that adds the five cheapest electricity hours for the
following day to a Google Calendar. Adjacent selected hours are combined into
one event.

## How it works

- Retrieves Dutch day-ahead electricity prices from the
  [EnergyZero public API](https://public.api.energyzero.nl/public/v1/prices).
- Averages the four 15-minute prices in each hour and selects the five cheapest
  hours.
- Creates events titled **Goedkope stroom** in the configured calendar.
- Colors events green, or blue when an event includes a selected hour with a
  negative average price.
- Replaces existing events with that title for the day being scheduled.
- Independently plans the Fox ESS battery schedule from tomorrow's quarter-hour
  prices and the battery's live SoC; it does not depend on calendar events.

The battery manager estimates the required charging duration from SoC using
eight quarter-hours as the 10%-to-100% baseline at 1200 W. At 85% SoC or above,
it skips charging and uses the cheapest hypothetical eight-quarter window as
the profitability reference. Other intervals use **SelfUse** when their price
is at least 1.20 times that reference price, and **Backup** otherwise. Adjacent
intervals with the same mode are merged. If the resulting groups exceed the
maximum reported by Fox ESS, the manager fails without replacing the existing
schedule. **SelfUse** relies on the existing HomeWizard P1 zero-export setup;
the manager does not communicate with the P1 meter. It also fails safely on
the autumn clock-change day, when Fox ESS cannot distinguish the repeated
local-time intervals.

The script uses EnergyZero's `base` price stream, which is the wholesale market
price in EUR/kWh, excluding VAT. It may not include taxes, supplier charges, or
other costs on your energy bill.

## Setup

1. Create a project at [Google Apps Script](https://script.google.com/).
2. Copy both `CheapEnergyCalendar.gs` and `FoxBatteryManager.gs` into the
   same project. The battery manager fetches its own prices and live SoC.
3. In the script, set `CALENDAR_NAME` to the exact name of the Google Calendar
   where events should be created. The default is `Huis`. Add the
   `SCRIPT_TIME_ZONE` property under **Project Settings > Script Properties**;
   use `Europe/Amsterdam` for Dutch local time.
4. Add `FOX_API_KEY`, `FOX_DEVICE_SN`, and `FOX_FD_POWER_W` under **Project
   Settings > Script Properties**. These are required by the Fox ESS battery
   manager. Set `FOX_FD_POWER_W` to the supported schedule power in watts; for
   the MQ2200-M-AC in this setup, use `1200` to match its current scheduler
   setting and the charge-duration estimate.
5. Save the project and run `installCalendarTrigger` and
   `installFoxBatteryTrigger` separately. Each function installs or replaces
   only its own daily trigger; the Fox installer also removes the old Dutch
   handler trigger if present. Accept the permissions requested for Google
   Calendar access and external requests.
6. Check the execution log for errors. The calendar is updated daily at
   approximately 16:00 and the Fox ESS schedule is synced at approximately
   23:00, both in the `Europe/Amsterdam` time zone.

EnergyZero publishes tomorrow's electricity prices around 14:00 UTC. The
16:00 Amsterdam trigger allows for that publication time in both winter and
summer. The script requests quarter-hour market prices for tomorrow's Dutch
local date and ignores prices outside that date. The calendar must exist and
its name must match exactly; if more than one calendar has that name, rename
them so the target is unambiguous.

## Configuration

Calendar settings are at the top of `CheapEnergyCalendar.gs`; Fox ESS settings,
including its trigger hour, price API URL, 1200 W baseline, SoC skip threshold,
and 1.20 discharge multiplier, are at the top of `FoxBatteryManager.gs`.
`SCRIPT_TIME_ZONE` is a required Script Property. Google Apps Script
time-based triggers run around the configured hour, not necessarily at an exact
minute. Run only the matching installer again after changing a trigger time.
If `SCRIPT_TIME_ZONE` changes, run both installers again so both triggers are
recreated in the new time zone. The calendar and battery triggers are otherwise
independent.

The calendar title and description templates are grouped in `EVENT_TEXT`.
When localizing them, keep the `{hours}`, `{minPrice}`, `{maxPrice}`, and
`{average}` placeholders unchanged.

## Fox ESS API tests

Run `test-foxess-scheduler-get.ps1` for a read-only Scheduler V3 capability
check. `test-foxess-scheduler-replace-restore.ps1` performs a write test: it
captures the current groups, replaces them with one temporary
`ForceCharge(BAT)` group, then restores the captured groups. It prompts for a
safe device-local time window and requires typing `REPLACE`. The test window
can cause charging; if the restore request fails or the script is interrupted,
restore the saved plan manually in Fox ESS Cloud.
