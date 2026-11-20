# Cheap Energy Calendar

A Google Apps Script that adds the five cheapest electricity hours for the
following day to a Google Calendar. Adjacent selected hours are combined into
one event.

## How it works

- Retrieves Dutch day-ahead electricity prices from the
  [Energy-Charts API](https://api.energy-charts.info/).
- Averages the four 15-minute prices in each hour and selects the five cheapest
  hours.
- Creates events titled **Goedkope stroom** in the configured calendar.
- Colors events green, or blue when an event includes a selected hour with a
  negative average price.
- Replaces existing events with that title for the day being scheduled.
- Checks the device's Scheduler V3 capabilities and sends those events to the
  Fox ESS scheduler using the configured schedule power value.

Prices shown in event descriptions are converted from EUR/MWh to EUR/kWh. They
are wholesale market prices and may not include taxes, supplier charges, or
other costs on your energy bill.

## Setup

1. Create a project at [Google Apps Script](https://script.google.com/).
2. Copy `CheapEnergyCalendar.gs` into the project.
3. In the script, set `CALENDAR_NAME` to the exact name of the Google Calendar
   where events should be created. The default is `Huis`.
4. Add `FOX_API_KEY`, `FOX_DEVICE_SN`, and `FOX_FD_POWER_W` under **Project
   Settings > Script Properties**. These are required by the scheduled Fox ESS
   sync. Set `FOX_FD_POWER_W` to the supported schedule power in watts; for the
   MQ2200-M-AC in this setup, use `1200` to match its current scheduler setting.
5. Save the project and run `installTriggers` once. Accept the permissions
   requested for Google Calendar access and external requests. If you previously
   installed the Dutch-named trigger handlers, this replaces them with the
   English-named handlers.
6. Check the execution log for errors. The calendar is updated daily at
   approximately 15:00 and the Fox ESS schedule is synced at approximately
   23:00, both in the `Europe/Amsterdam` time zone.

The script uses the Netherlands (`NL`) price zone. The calendar must exist and
its name must match exactly; if more than one calendar has that name, rename
them so the target is unambiguous.

## Configuration

The constants at the top of `CheapEnergyCalendar.gs` control the calendar name,
event title and colors, price zone/API URL, trigger hours, and number of
cheapest hours. Google Apps Script time-based triggers run around the
configured hour, not necessarily at an exact minute. Run `installTriggers`
again after changing trigger settings; it replaces the existing triggers for
these handlers, including the previous Dutch-named handlers.

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
