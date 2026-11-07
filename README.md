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

Prices shown in event descriptions are converted from EUR/MWh to EUR/kWh. They
are wholesale market prices and may not include taxes, supplier charges, or
other costs on your energy bill.

## Setup

1. Create a project at [Google Apps Script](https://script.google.com/).
2. Copy `CheapEnergyCalendar.gs` into the project.
3. In the script, set `CALENDAR_NAME` to the exact name of the Google Calendar
   where events should be created. The default is `Huis`.
4. Save the project and run `installDagelijkseTrigger` once. Accept the
   permissions requested for Google Calendar access and external requests.
5. Check the execution log for errors. The script runs daily at approximately
   15:00 in the `Europe/Amsterdam` time zone.

The script uses the Netherlands (`NL`) price zone. The calendar must exist and
its name must match exactly; if more than one calendar has that name, rename
them so the target is unambiguous.

## Configuration

The constants at the top of `CheapEnergyCalendar.gs` control the calendar name,
event title and colors, price zone/API URL, schedule, and number of cheapest
hours. Google Apps Script time-based triggers run around the configured hour,
not necessarily at an exact minute.
