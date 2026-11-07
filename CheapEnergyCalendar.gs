const CALENDAR_NAME = 'Huis';
const CHEAP_PRICE_COLOR = CalendarApp.EventColor.PALE_GREEN;
const NEGATIVE_PRICE_COLOR = CalendarApp.EventColor.BLUE;
const PRICE_API_URL = 'https://api.energy-charts.info/v2/price_next_day?bzn=NL';
const PRICE_INTERVAL_MINUTES = 15;
const EVENT_TITLE = 'Goedkope stroom';
const SCRIPT_TIME_ZONE = 'Europe/Amsterdam';
const DAILY_TRIGGER_HOUR = 15;
const CHEAPEST_HOURS = 5;

function installDagelijkseTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'planGoedkopeStroom')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('planGoedkopeStroom')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_TRIGGER_HOUR)
    .inTimezone(SCRIPT_TIME_ZONE)
    .create();

  Logger.log(
    `Dagelijkse trigger ingesteld rond ${DAILY_TRIGGER_HOUR}:00 (${SCRIPT_TIME_ZONE}).`
  );
}

function planGoedkopeStroom() {
  const response = UrlFetchApp.fetch(PRICE_API_URL, {
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(
      `Energy-Charts API gaf HTTP ${status}: ${response.getContentText()}`
    );
  }

  const priceData = JSON.parse(response.getContentText());
  if (!priceData || !priceData.attributes || !priceData.attributes.delivery_date ||
      !Array.isArray(priceData.data) || priceData.data.length === 0) {
    throw new Error('De API heeft geen day-aheadprijzen voor morgen teruggegeven.');
  }

  const quarterHours = priceData.data.map(record => {
    const start = new Date(record.timestamp);
    const price = record.values && record.values.day_ahead_price;
    if (Number.isNaN(start.getTime()) || typeof price !== 'number' ||
        !Number.isFinite(price)) {
      throw new Error('De API bevat een ongeldige tijd of prijs; agenda niet aangepast.');
    }
    return {
      start: start,
      end: new Date(start.getTime() + PRICE_INTERVAL_MINUTES * 60000),
      price: price
    };
  });

  for (let i = 1; i < quarterHours.length; i++) {
    if (quarterHours[i].start.getTime() !== quarterHours[i - 1].end.getTime()) {
      throw new Error('De API-prijsintervallen zijn niet aaneengesloten; agenda niet aangepast.');
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
    throw new Error('Niet alle uren bevatten vier kwartierprijzen; agenda niet aangepast.');
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
  const calendars = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (calendars.length !== 1) {
    throw new Error(
      calendars.length === 0
        ? `Agenda '${CALENDAR_NAME}' niet gevonden.`
        : `Er zijn meerdere agenda's met de naam '${CALENDAR_NAME}'; maak de naam uniek.`
    );
  }
  const calendar = calendars[0];
  const dayStart = intervals[0].start;
  const dayEnd = intervals[intervals.length - 1].end;

  calendar.getEvents(dayStart, dayEnd).forEach(event => {
    if (event.getTitle().toLowerCase() === EVENT_TITLE.toLowerCase()) {
      event.deleteEvent();
    }
  });

  const createEvent = (start, end, minPrice, maxPrice, hasNegativePrice) => {
    calendar.createEvent(EVENT_TITLE, start, end, {
      description:
        `Een van de ${selectedHours.length} goedkoopste uren van morgen.\n` +
        `Prijs in dit interval: €${(minPrice / 1000).toFixed(4)}-` +
        `€${(maxPrice / 1000).toFixed(4)} per kWh.\n` +
        (hasNegativePrice ? 'Let op: de gemiddelde uurprijs is negatief.\n' : '') +
        `Daggemiddelde: €${(average / 1000).toFixed(4)} per kWh.\n` +
        'Bron: Energy-Charts API (Bundesnetzagentur | SMARD.de).'
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
    `Agenda '${CALENDAR_NAME}' bijgewerkt voor ${priceData.attributes.delivery_date}. ` +
    `${selectedHours.length} goedkoopste uren ingepland; daggemiddelde ` +
    `€${(average / 1000).toFixed(4)} per kWh.`
  );
}
