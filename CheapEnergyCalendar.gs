const CHEAP_PRICE_COLOR = CalendarApp.EventColor.PALE_GREEN;
const NEGATIVE_PRICE_COLOR = CalendarApp.EventColor.BLUE;
const PRICE_API_URL = 'https://public.api.energyzero.nl/public/v1/prices';
const PRICE_INTERVAL_MINUTES = 15;
const EVENT_TEXT = {
  title: 'Goedkope stroom',
  summary: 'Een van de {hours} goedkoopste uren van morgen.',
  intervalPrice: 'Prijs in dit interval: \u20AC{minPrice}-\u20AC{maxPrice} per kWh.',
  negativePriceWarning: 'Let op: de gemiddelde uurprijs is negatief.',
  dailyAverage: 'Daggemiddelde: \u20AC{average} per kWh.',
  source: 'Bron: EnergyZero API (marktprijs, exclusief btw).'
};
const CALENDAR_MESSAGES = {
  ERROR_MESSAGES: {
    energyZeroNotPublished:
      'EnergyZero has not yet published prices for {date}. ' +
      'The calendar was not updated; please try again after {hour}:00 ({timeZone}).',
    energyZeroHttp: 'EnergyZero API returned HTTP {status}: {responseText}',
    energyZeroInvalidJson: 'EnergyZero API returned invalid JSON: {responseText}',
    energyZeroInvalidPriceList: 'EnergyZero API did not return a valid price list.',
    energyZeroInvalidTimeOrPrice:
      'EnergyZero API contains an invalid time or price; calendar not updated.',
    energyZeroIncompletePriceDay:
      'EnergyZero API did not return a complete price day; calendar not updated.',
    energyZeroNonContiguousIntervals:
      'EnergyZero API price intervals are not contiguous; calendar not updated.',
    incompleteHourPrices:
      'The price data does not contain four quarter-hour prices for every hour; ' +
      'the calendar was not updated.',
    missingCalendarName:
      'CALENDAR_NAME is missing from Script Properties. Set it to the exact calendar name.',
    calendarNotFound: "Calendar '{calendarName}' not found.",
    multipleCalendarsFound:
      "Multiple calendars found with the name '{calendarName}'; please make the name unique.",
    missingTimeZone:
      'SCRIPT_TIME_ZONE is missing from Script Properties. ' +
      'For example, set it to Europe/Amsterdam.',
    invalidTimeZone:
      "SCRIPT_TIME_ZONE '{timeZone}' is not a valid time zone: {details}"
  },
  LOG_messages: {
    calendarTriggerSet:
      'Calendar trigger set for approximately {hour}:00 ({timeZone}).',
    calendarUpdated:
      "Calendar '{calendarName}' updated for {date}. {selectedHours} cheapest hours scheduled."
  }
};

const AGENDA_TRIGGER_HOUR = 16;
const CHEAPEST_HOURS = 5;

/**
 * Run once to install or reinstall the daily calendar trigger.
 */
function installCalendarTrigger() {
  const timeZone = getCalendarTimeZone();
  const targetHandlers = [
    'scheduleCheapestElectricity',
    'planGoedkopeStroom'
  ];

  ScriptApp.getProjectTriggers()
    .filter(trigger => targetHandlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('scheduleCheapestElectricity')
    .timeBased()
    .everyDays(1)
    .atHour(AGENDA_TRIGGER_HOUR)
    .inTimezone(timeZone)
    .create();

  Logger.log(formatTextTemplate(CALENDAR_MESSAGES.LOG_messages.calendarTriggerSet, {
    hour: AGENDA_TRIGGER_HOUR,
    timeZone: timeZone
  }));
}

/**
 * Runs at 16:00 to fetch tomorrow's prices and schedule the cheapest hours.
 */
function scheduleCheapestElectricity() {
  const timeZone = getCalendarTimeZone();
  const todayInAmsterdam = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const [year, month, day] = todayInAmsterdam.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const dayAfterTomorrow = new Date(Date.UTC(year, month - 1, day + 2));
  const tomorrowDate = Utilities.formatDate(tomorrow, 'UTC', 'yyyy-MM-dd');
  const tomorrowApiDate = Utilities.formatDate(tomorrow, 'UTC', 'dd-MM-yyyy');
  const requestedDayStart = Utilities.parseDate(
    `${tomorrowDate} 00:00:00`,
    timeZone,
    'yyyy-MM-dd HH:mm:ss'
  );
  const dayAfterTomorrowDate = Utilities.formatDate(dayAfterTomorrow, 'UTC', 'yyyy-MM-dd');
  const requestedDayEnd = Utilities.parseDate(
    `${dayAfterTomorrowDate} 00:00:00`,
    timeZone,
    'yyyy-MM-dd HH:mm:ss'
  );
  const requestUrl =
    `${PRICE_API_URL}?energyType=ENERGY_TYPE_ELECTRICITY` +
    `&date=${encodeURIComponent(tomorrowApiDate)}&interval=INTERVAL_QUARTER`;
  const response = UrlFetchApp.fetch(requestUrl, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status !== 200) {
    // EnergyZero returns this 404 until all quarter-hour prices for the requested date are published.
    if (status === 404 &&
        responseText.toLowerCase().includes('prices do not span the whole requested date')) {
      throw new Error(
          formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroNotPublished, {
          date: tomorrowDate,
          hour: AGENDA_TRIGGER_HOUR,
          timeZone: timeZone
        })
      );
    }
    throw new Error(formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroHttp, {
      status: status,
      responseText: responseText
    }));
  }

  let priceData;
  try {
    priceData = JSON.parse(responseText);
  } catch (error) {
    throw new Error(formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroInvalidJson, {
      responseText: responseText
    }));
  }

  if (!priceData || !Array.isArray(priceData.base)) {
    throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroInvalidPriceList);
  }

  const quarterHours = priceData.base
    .filter(record => {
      const start = new Date(record.start);
      return !Number.isNaN(start.getTime()) &&
        start >= requestedDayStart && start < requestedDayEnd;
    })
    .map(record => {
      const start = new Date(record.start);
      const end = new Date(record.end);
      const rawPrice = record.price && record.price.value;
      const price = Number(rawPrice);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ||
          end.getTime() - start.getTime() !== PRICE_INTERVAL_MINUTES * 60000 ||
          (typeof rawPrice !== 'string' && typeof rawPrice !== 'number') ||
          rawPrice === '' || !Number.isFinite(price)) {
        throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroInvalidTimeOrPrice);
      }
      return {
        start: start,
        end: end,
        price: price
      };
    });

  if (quarterHours.length === 0 ||
      quarterHours[0].start.getTime() !== requestedDayStart.getTime() ||
      quarterHours[quarterHours.length - 1].end.getTime() !== requestedDayEnd.getTime()) {
    throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroIncompletePriceDay);
  }

  for (let i = 1; i < quarterHours.length; i++) {
    if (quarterHours[i].start.getTime() !== quarterHours[i - 1].end.getTime()) {
      throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.energyZeroNonContiguousIntervals);
    }
  }

  const hourlyPrices = [];
  quarterHours.forEach(item => {
    const hourKey = Math.floor(item.start.getTime() / (60 * 60 * 1000));
    let hour = hourlyPrices[hourlyPrices.length - 1];
    if (!hour || hour.key !== hourKey) {
      hour = { key: hourKey, start: item.start, end: item.end, prices: [] };
      hourlyPrices.push(hour);
    }
    hour.prices.push(item.price);
    hour.end = item.end;
  });

  if (hourlyPrices.some(hour => hour.prices.length !== 4)) {
    throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.incompleteHourPrices);
  }

  const intervals = hourlyPrices.map(hour => {
    const price = hour.prices.reduce((sum, value) => sum + value, 0) / hour.prices.length;
    return {
      start: hour.start,
      end: hour.end,
      price: price,
      hasNegativePrice: price < 0
    };
  });

  const average = intervals.reduce((sum, item) => sum + item.price, 0) / intervals.length;
  const selectedHours = intervals
    .slice()
    .sort((a, b) => a.price - b.price || a.start.getTime() - b.start.getTime())
    .slice(0, Math.min(CHEAPEST_HOURS, intervals.length));
  const selectedHourTimes = new Set(selectedHours.map(item => item.start.getTime()));

  const calendarName = getCalendarName();
  const calendar = getUniqueCalendar(calendarName);
  const dayStart = intervals[0].start;
  const dayEnd = intervals[intervals.length - 1].end;

  calendar.getEvents(dayStart, dayEnd).forEach(event => {
    if (event.getTitle().toLowerCase() === EVENT_TEXT.title.toLowerCase()) {
      event.deleteEvent();
    }
  });

  const createEvent = (start, end, minPrice, maxPrice, hasNegativePrice) => {
    const textValues = {
      hours: selectedHours.length,
      minPrice: minPrice.toFixed(4),
      maxPrice: maxPrice.toFixed(4),
      average: average.toFixed(4)
    };
    const description = [
      formatTextTemplate(EVENT_TEXT.summary, textValues),
      formatTextTemplate(EVENT_TEXT.intervalPrice, textValues),
      ...(hasNegativePrice ? [EVENT_TEXT.negativePriceWarning] : []),
      formatTextTemplate(EVENT_TEXT.dailyAverage, textValues),
      EVENT_TEXT.source
    ].join('\n');

    calendar.createEvent(EVENT_TEXT.title, start, end, {
      description: description
    }).setColor(hasNegativePrice ? NEGATIVE_PRICE_COLOR : CHEAP_PRICE_COLOR);
  };

  let eventStart = null;
  let eventEnd = null;
  let eventMinPrice = null;
  let eventMaxPrice = null;
  let eventHasNegativePrice = false;

  selectedHours.sort((a, b) => a.start.getTime() - b.start.getTime());
  intervals.forEach(item => {
    if (selectedHourTimes.has(item.start.getTime())) {
      if (eventEnd && eventEnd.getTime() !== item.start.getTime()) {
        createEvent(eventStart, eventEnd, eventMinPrice, eventMaxPrice, eventHasNegativePrice);
        eventStart = null;
      }
      if (!eventStart) {
        eventStart = item.start;
        eventMinPrice = item.price;
        eventMaxPrice = item.price;
        eventHasNegativePrice = item.hasNegativePrice;
      } else {
        eventMinPrice = Math.min(eventMinPrice, item.price);
        eventMaxPrice = Math.max(eventMaxPrice, item.price);
        eventHasNegativePrice = eventHasNegativePrice || item.hasNegativePrice;
      }
      eventEnd = item.end;
    } else if (eventStart) {
      createEvent(eventStart, eventEnd, eventMinPrice, eventMaxPrice, eventHasNegativePrice);
      eventStart = null;
      eventEnd = null;
      eventMinPrice = null;
      eventMaxPrice = null;
      eventHasNegativePrice = false;
    }
  });

  if (eventStart) {
    createEvent(eventStart, eventEnd, eventMinPrice, eventMaxPrice, eventHasNegativePrice);
  }

  Logger.log(formatTextTemplate(CALENDAR_MESSAGES.LOG_messages.calendarUpdated, {
    calendarName: calendarName,
    date: tomorrowDate,
    selectedHours: selectedHours.length
  }));
}

function formatTextTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key]);
}

function getCalendarName() {
  const calendarName = PropertiesService.getScriptProperties().getProperty('CALENDAR_NAME');
  if (!calendarName || !calendarName.trim()) {
    throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.missingCalendarName);
  }
  return calendarName;
}

function getUniqueCalendar(calendarName) {
  const calendars = CalendarApp.getCalendarsByName(calendarName);
  if (calendars.length !== 1) {
    throw new Error(
      calendars.length === 0
        ? formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.calendarNotFound, {
            calendarName: calendarName
          })
        : formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.multipleCalendarsFound, {
            calendarName: calendarName
          })
    );
  }
  return calendars[0];
}

function getCalendarTimeZone() {
  const timeZone = PropertiesService.getScriptProperties().getProperty('SCRIPT_TIME_ZONE');
  if (!timeZone) {
    throw new Error(CALENDAR_MESSAGES.ERROR_MESSAGES.missingTimeZone);
  }

  try {
    Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  } catch (error) {
    throw new Error(formatTextTemplate(CALENDAR_MESSAGES.ERROR_MESSAGES.invalidTimeZone, {
      timeZone: timeZone,
      details: error.message
    }));
  }
  return timeZone;
}
