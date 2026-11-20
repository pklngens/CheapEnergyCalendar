const CALENDAR_NAME = 'Huis';
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
const SCRIPT_TIME_ZONE = 'Europe/Amsterdam';

const AGENDA_TRIGGER_HOUR = 16; // 16:00: fetch prices and add them to the calendar
const FOX_SYNC_TRIGGER_HOUR = 23; // 23:00: send tomorrow's time blocks to the battery
const CHEAPEST_HOURS = 5;
const FOX_BASE_URL = 'https://www.foxesscloud.com';

/**
 * Run once to install the daily calendar and Fox ESS triggers.
 */
function installTriggers() {
  // Include legacy names so reinstalling removes previously created triggers.
  const targetHandlers = [
    'scheduleCheapestElectricity',
    'syncFoxESSForTomorrow',
    'planGoedkopeStroom',
    'syncFoxESSVoorMorgen'
  ];

  ScriptApp.getProjectTriggers()
    .filter(trigger => targetHandlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('scheduleCheapestElectricity')
    .timeBased()
    .everyDays(1)
    .atHour(AGENDA_TRIGGER_HOUR)
    .inTimezone(SCRIPT_TIME_ZONE)
    .create();

  ScriptApp.newTrigger('syncFoxESSForTomorrow')
    .timeBased()
    .everyDays(1)
    .atHour(FOX_SYNC_TRIGGER_HOUR)
    .inTimezone(SCRIPT_TIME_ZONE)
    .create();

  Logger.log(
    `Triggers set: calendar at ${AGENDA_TRIGGER_HOUR}:00, ` +
    `Fox ESS sync at ${FOX_SYNC_TRIGGER_HOUR}:00 (${SCRIPT_TIME_ZONE}).`
  );
}

/**
 * Runs at 16:00 to fetch tomorrow's prices and schedule the cheapest hours.
 */
function scheduleCheapestElectricity() {
  const todayInAmsterdam = Utilities.formatDate(new Date(), SCRIPT_TIME_ZONE, 'yyyy-MM-dd');
  const [year, month, day] = todayInAmsterdam.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const dayAfterTomorrow = new Date(Date.UTC(year, month - 1, day + 2));
  const tomorrowDate = Utilities.formatDate(tomorrow, 'UTC', 'yyyy-MM-dd');
  const tomorrowApiDate = Utilities.formatDate(tomorrow, 'UTC', 'dd-MM-yyyy');
  const requestedDayStart = Utilities.parseDate(
    `${tomorrowDate} 00:00:00`,
    SCRIPT_TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss'
  );
  const dayAfterTomorrowDate = Utilities.formatDate(dayAfterTomorrow, 'UTC', 'yyyy-MM-dd');
  const requestedDayEnd = Utilities.parseDate(
    `${dayAfterTomorrowDate} 00:00:00`,
    SCRIPT_TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss'
  );
  const requestUrl =
    `${PRICE_API_URL}?energyType=ENERGY_TYPE_ELECTRICITY` +
    `&date=${encodeURIComponent(tomorrowApiDate)}&interval=INTERVAL_QUARTER`;
  const response = UrlFetchApp.fetch(requestUrl, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`EnergyZero API returned HTTP ${status}: ${response.getContentText()}`);
  }

  const responseText = response.getContentText();
  let priceData;
  try {
    priceData = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`EnergyZero API returned invalid JSON: ${responseText}`);
  }

  if (!priceData || !Array.isArray(priceData.base)) {
    throw new Error('EnergyZero API did not return a valid price list.');
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
        throw new Error('EnergyZero API contains an invalid time or price; calendar not updated.');
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
    throw new Error('EnergyZero API did not return a complete price day; calendar not updated.');
  }

  for (let i = 1; i < quarterHours.length; i++) {
    if (quarterHours[i].start.getTime() !== quarterHours[i - 1].end.getTime()) {
      throw new Error('EnergyZero API price intervals are not contiguous; calendar not updated.');
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
    throw new Error('Not all hours contain four quarter-hour prices; calendar not updated.');
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

  const calendar = getUniqueCalendar();
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
      formatEventText(EVENT_TEXT.summary, textValues),
      formatEventText(EVENT_TEXT.intervalPrice, textValues),
      ...(hasNegativePrice ? [EVENT_TEXT.negativePriceWarning] : []),
      formatEventText(EVENT_TEXT.dailyAverage, textValues),
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

  Logger.log(
    `Calendar '${CALENDAR_NAME}' updated for ${tomorrowDate}. ` +
    `${selectedHours.length} cheapest hours scheduled.`
  );
}

/**
 * Runs at 23:00 to send tomorrow's calendar blocks to the Fox ESS scheduler.
 */
function syncFoxESSForTomorrow() {
  const calendar = getUniqueCalendar();

  const todayInAmsterdam = Utilities.formatDate(new Date(), SCRIPT_TIME_ZONE, 'yyyy-MM-dd');
  const [year, month, day] = todayInAmsterdam.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const dayAfterTomorrow = new Date(Date.UTC(year, month - 1, day + 2));
  const tomorrowStart = Utilities.parseDate(
    Utilities.formatDate(tomorrow, 'UTC', 'yyyy-MM-dd') + ' 00:00:00',
    SCRIPT_TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss'
  );
  const tomorrowEnd = Utilities.parseDate(
    Utilities.formatDate(dayAfterTomorrow, 'UTC', 'yyyy-MM-dd') + ' 00:00:00',
    SCRIPT_TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss'
  );

  const events = calendar.getEvents(tomorrowStart, tomorrowEnd)
    .filter(event => event.getTitle().toLowerCase() === EVENT_TEXT.title.toLowerCase());

  const blocks = events.map(event => ({
    start: event.getStartTime(),
    end: event.getEndTime()
  }));

  updateFoxChargeSchedule(blocks);
}

function formatEventText(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key]);
}

function getUniqueCalendar() {
  const calendars = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (calendars.length !== 1) {
    throw new Error(
      calendars.length === 0
        ? `Calendar '${CALENDAR_NAME}' not found.`
        : `Multiple calendars found with the name '${CALENDAR_NAME}'; please make the name unique.`
    );
  }
  return calendars[0];
}

function updateFoxChargeSchedule(blocks) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const apiKey = scriptProperties.getProperty('FOX_API_KEY');
  const deviceSN = scriptProperties.getProperty('FOX_DEVICE_SN');
  const forcePowerWatts = Number(scriptProperties.getProperty('FOX_FD_POWER_W'));

  if (!apiKey || !deviceSN) {
    throw new Error('FOX_API_KEY or FOX_DEVICE_SN is missing in Script Properties.');
  }
  if (!Number.isInteger(forcePowerWatts) || forcePowerWatts <= 0) {
    throw new Error('FOX_FD_POWER_W must be set as a positive integer number of watts in Script Properties.');
  }
  if (blocks.length === 0) {
    throw new Error('No charging blocks found for tomorrow; existing Fox ESS schedule was not modified.');
  }

  const scheduler = foxApiPost(
    '/op/v3/device/scheduler/get',
    apiKey,
    { deviceSN: deviceSN }
  );
  if (!scheduler || typeof scheduler !== 'object') {
    throw new Error('Fox ESS did not return a valid Scheduler V3 configuration.');
  }

  const properties = scheduler.properties || {};
  const workModeProperty = getFoxSchedulerProperty(properties, 'workmode');
  const supportedModes = workModeProperty && workModeProperty.enumList;
  let workMode = 'ForceCharge';
  if (Array.isArray(supportedModes)) {
    if (supportedModes.includes('ForceCharge(BAT)')) {
      workMode = 'ForceCharge(BAT)';
    } else if (!supportedModes.includes(workMode)) {
      throw new Error('This Fox ESS device does not support the ForceCharge scheduler mode.');
    }
  }

  const maxGroupCount = Number(scheduler.maxGroupCount);
  if (Number.isFinite(maxGroupCount) && blocks.length > maxGroupCount) {
    throw new Error(
      `Fox ESS supports a maximum of ${maxGroupCount} scheduler blocks; ` +
      `${blocks.length} blocks are required.`
    );
  }

  const scheduleValues = {
    minSocOnGrid: 10,
    fdSoc: 100,
    fdPwr: forcePowerWatts,
    maxSoc: 100
  };
  Object.keys(scheduleValues).forEach(fieldName => {
    validateFoxSchedulerValue(properties, fieldName, scheduleValues[fieldName]);
  });

  const groups = blocks.map(block => {
    const startHour = Number(Utilities.formatDate(block.start, SCRIPT_TIME_ZONE, 'H'));
    const startMinute = Number(Utilities.formatDate(block.start, SCRIPT_TIME_ZONE, 'm'));
    let endHour = Number(Utilities.formatDate(block.end, SCRIPT_TIME_ZONE, 'H'));
    let endMinute = Number(Utilities.formatDate(block.end, SCRIPT_TIME_ZONE, 'm'));

    if (endHour === 0 && endMinute === 0) {
      endHour = 23;
      endMinute = 59;
    }

    return {
      workMode: workMode,
      startHour: startHour,
      startMinute: startMinute,
      endHour: endHour,
      endMinute: endMinute,
      extraParam: scheduleValues
    };
  });

  foxApiPost(
    '/op/v3/device/scheduler/enable',
    apiKey,
    {
      deviceSN: deviceSN,
      isDefault: false,
      groups: groups
    }
  );

  Logger.log(
    `Fox ESS Mode Scheduler updated with ${groups.length} charging block(s) ` +
    `for tomorrow (${workMode}, ${forcePowerWatts} W).`
  );
}

function foxApiPost(path, apiKey, payload) {
  const response = UrlFetchApp.fetch(FOX_BASE_URL + path, {
    method: 'post',
    contentType: 'application/json',
    headers: createFoxRequestHeaders(path, apiKey),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Fox ESS API returned HTTP ${status}: ${responseText || '(empty response)'}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Fox ESS API did not return a valid JSON response (HTTP ${status}): ` +
      `${responseText || '(empty response)'}`
    );
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error(`Fox ESS API returned an invalid response: ${responseText}`);
  }
  if (envelope.errno !== 0) {
    throw new Error(`Fox ESS API error (${envelope.errno}): ${responseText}`);
  }

  return envelope.result;
}

function getFoxSchedulerProperty(properties, name) {
  const key = Object.keys(properties).find(
    propertyName => propertyName.toLowerCase() === name.toLowerCase()
  );
  return key ? properties[key] : null;
}

function validateFoxSchedulerValue(properties, fieldName, value) {
  const property = getFoxSchedulerProperty(properties, fieldName);
  const range = property && property.range;
  if (!range) {
    return;
  }

  const minimum = Number(range.min);
  const maximum = Number(range.max);
  if ((Number.isFinite(minimum) && value < minimum) ||
      (Number.isFinite(maximum) && value > maximum)) {
    throw new Error(
      `FOX scheduler value ${fieldName}=${value} is outside the device range ` +
      `${range.min}-${range.max}.`
    );
  }
}

function createFoxRequestHeaders(path, apiKey) {
  const timestamp = Date.now().toString();
  const rawSignature = `${path}\r\n${apiKey}\r\n${timestamp}`;
  const signatureBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    rawSignature,
    Utilities.Charset.UTF_8
  );
  const signature = signatureBytes
    .map(byte => ('0' + (byte & 0xff).toString(16)).slice(-2))
    .join('');

  return {
    token: apiKey,
    timestamp: timestamp,
    signature: signature,
    lang: 'en'
  };
}
