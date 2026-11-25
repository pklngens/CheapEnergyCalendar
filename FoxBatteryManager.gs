const FOX_SYNC_TRIGGER_HOUR = 23;
const FOX_MIDDAY_TRIGGER_HOUR = 10;
const FOX_BASE_URL = 'https://www.foxesscloud.com';
const FOX_PRICE_API_URL = 'https://public.api.energyzero.nl/public/v1/prices';
const FOX_PRICE_INTERVAL_MINUTES = 15;
// Eight quarter-hours represent charging from 10% to 100% at 1200 W.
const FOX_FULL_CHARGE_QUARTERS = 8;
const FOX_SKIP_CHARGING_SOC = 85;
const FOX_DISCHARGE_PRICE_MULTIPLIER = 1.20;
const FOX_MIN_DISCHARGE_SPREAD_EUR = 0.045;
const FOX_WEEKEND_MORNING_MULTIPLIER = 1.28;
const FOX_WEEKDAY_NO_MIDDAY_MORNING_MULTIPLIER = 1.35;
const FOX_WEEKDAY_EVENING_START_HOUR = 17;
const FOX_WEEKEND_EVENING_START_HOUR = 15;
const FOX_MIDDAY_TOPUP_QUARTERS = 6;
const FOX_MIDDAY_SPREAD_MULTIPLIER = 1.20;
const FOX_MESSAGES = {
  ERROR_MESSAGES: {
    missingTimeZone:
      'SCRIPT_TIME_ZONE is missing from Script Properties. ' +
      'For example, set it to Europe/Amsterdam.',
    invalidTimeZone:
      "SCRIPT_TIME_ZONE '{timeZone}' is not a valid time zone: {details}",
    energyZeroNotPublished:
      'EnergyZero has not yet published all prices for {date}; the Fox ESS schedule was not updated.',
    energyZeroHttp: 'EnergyZero API returned HTTP {status}: {responseText}',
    energyZeroInvalidJson: 'EnergyZero API returned invalid JSON: {responseText}',
    energyZeroInvalidPriceList: 'EnergyZero API did not return a valid price list.',
    energyZeroInvalidTimestampOrPrice: 'EnergyZero contains an invalid timestamp or price.',
    energyZeroIncompletePriceDay:
      'EnergyZero did not return a complete price day for {date}.',
    energyZeroNonContiguousIntervals: 'EnergyZero price intervals are not contiguous.',
    invalidCurrentSoc: 'Fox ESS did not return a valid current SoC value.',
    invalidConsumerPriceProperty:
      '{propertyName} must be a non-negative finite number when configured.',
    requiredChargingTimeExceedsPriceDay:
      'The calculated charging window does not fit within the available price intervals.',
    missingFoxCredentials: 'FOX_API_KEY or FOX_DEVICE_SN is missing in Script Properties.',
    invalidForcePower:
      'FOX_FD_POWER_W must be set in Script Properties to a positive integer number of watts.',
    invalidSchedulerConfiguration:
      'Fox ESS did not return a valid Scheduler V3 configuration.',
    missingSchedulerModes: 'The Fox ESS response did not include the supported scheduler modes.',
    unsupportedSchedulerModes:
      'This Fox ESS device does not support these modes: {modes}.',
    invalidMaximumGroupCount: 'Fox ESS did not return a valid maximum group count.',
    tooManyScheduleGroups:
      'The schedule contains {groupCount} groups, but Fox ESS allows at most ' +
      '{maxGroupCount}. The existing schedule was not updated.',
    foxApiHttp: 'Fox ESS API returned HTTP {status}: {responseText}',
    foxApiInvalidJson:
      'Fox ESS API returned invalid JSON (HTTP {status}): {responseText}',
    foxApiInvalidResponse: 'Fox ESS API returned an invalid response: {responseText}',
    foxApiError: 'Fox ESS API error ({errno}): {responseText}',
    schedulerValueOutOfRange:
      'Fox scheduler value {fieldName}={value} is outside the device range {minimum}-{maximum}.'
  },
  LOG_messages: {
    triggerSet: 'Fox ESS battery trigger set for approximately {hour}:00 ({timeZone}).',
    middayTriggerSet:
      'Fox ESS midday battery trigger set for approximately {time} ({timeZone}).',
    scheduleUpdated:
      'Fox ESS scheduler updated for {date}: SoC {currentSoc}%, ' +
      '{requiredQuarters} charging quarter(s), {groupCount} group(s), ' +
      'morning discharge threshold {minDischargePrice} EUR/kWh, ' +
      'after-{eveningStartHour}:00 threshold {eveningDischargePrice} EUR/kWh; ' +
      'midday top-up {middayTopUp}.'
  }
};

/**
 * Run once to install or reinstall the daily Fox ESS battery trigger.
 */
function installFoxBatteryTrigger() {
  const timeZone = getFoxBatteryTimeZone();
  const targetHandlers = [
    'syncFoxESSForTomorrow',
    'syncFoxESSVoorMorgen',
    'syncFoxESSForMidday'
  ];

  ScriptApp.getProjectTriggers()
    .filter(trigger => targetHandlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('syncFoxESSForTomorrow')
    .timeBased()
    .everyDays(1)
    .atHour(FOX_SYNC_TRIGGER_HOUR)
    .inTimezone(timeZone)
    .create();

  ScriptApp.newTrigger('syncFoxESSForMidday')
    .timeBased()
    .everyDays(1)
    .atHour(FOX_MIDDAY_TRIGGER_HOUR)
    .nearMinute(15)
    .inTimezone(timeZone)
    .create();

  Logger.log(formatFoxMessage(FOX_MESSAGES.LOG_messages.triggerSet, {
    hour: FOX_SYNC_TRIGGER_HOUR,
    timeZone: timeZone
  }));
  Logger.log(formatFoxMessage(FOX_MESSAGES.LOG_messages.middayTriggerSet, {
    time: `${FOX_MIDDAY_TRIGGER_HOUR}:15`,
    timeZone: timeZone
  }));
}

/**
 * Runs at 23:00 to plan tomorrow's battery modes from SoC and market prices.
 */
function syncFoxESSForTomorrow() {
  updateFoxChargeSchedule(false);
}

/**
 * Runs around 10:15 to re-evaluate today's remaining midday charge window.
 */
function syncFoxESSForMidday() {
  updateFoxChargeSchedule(true);
}

function getFoxBatteryTimeZone() {
  const timeZone = PropertiesService.getScriptProperties().getProperty('SCRIPT_TIME_ZONE');
  if (!timeZone) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.missingTimeZone);
  }

  try {
    Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  } catch (error) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.invalidTimeZone, {
      timeZone: timeZone,
      details: error.message
    }));
  }
  return timeZone;
}

function getFoxDayBounds(timeZone, dayOffset) {
  const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const [year, month, day] = today.split('-').map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const dayAfterTarget = new Date(Date.UTC(year, month - 1, day + dayOffset + 1));
  const date = Utilities.formatDate(targetDate, 'UTC', 'yyyy-MM-dd');

  return {
    date: date,
    apiDate: Utilities.formatDate(targetDate, 'UTC', 'dd-MM-yyyy'),
    start: Utilities.parseDate(
      `${date} 00:00:00`,
      timeZone,
      'yyyy-MM-dd HH:mm:ss'
    ),
    end: Utilities.parseDate(
      Utilities.formatDate(dayAfterTarget, 'UTC', 'yyyy-MM-dd') + ' 00:00:00',
      timeZone,
      'yyyy-MM-dd HH:mm:ss'
    )
  };
}

function getFoxTomorrowBounds(timeZone) {
  return getFoxDayBounds(timeZone, 1);
}

function getFoxTodayBounds(timeZone) {
  return getFoxDayBounds(timeZone, 0);
}

function getFoxOptionalCostProperty(scriptProperties, propertyName) {
  const rawValue = scriptProperties.getProperty(propertyName);
  if (rawValue === null) {
    return 0;
  }
  const value = Number(rawValue);
  if (rawValue.trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new Error(formatFoxMessage(
      FOX_MESSAGES.ERROR_MESSAGES.invalidConsumerPriceProperty,
      { propertyName: propertyName }
    ));
  }
  return value;
}

function applyFoxConsumerPrices(intervals, scriptProperties) {
  const energyTax = getFoxOptionalCostProperty(
    scriptProperties,
    'ENERGY_TAX_EUR_KWH'
  );
  const supplierFee = getFoxOptionalCostProperty(
    scriptProperties,
    'SUPPLIER_FEE_EUR_KWH'
  );
  const vatPercentage = getFoxOptionalCostProperty(
    scriptProperties,
    'VAT_PERCENTAGE'
  );
  const vatMultiplier = 1 + vatPercentage / 100;
  return intervals.map(interval => {
    const price = (interval.price + supplierFee) * vatMultiplier + energyTax;
    if (!Number.isFinite(price)) {
      throw new Error(FOX_MESSAGES.ERROR_MESSAGES.energyZeroInvalidTimestampOrPrice);
    }
    return {
      start: interval.start,
      end: interval.end,
      price: price
    };
  });
}

function fetchFoxEnergyZeroPrices(dayBounds) {
  const url =
    `${FOX_PRICE_API_URL}?energyType=ENERGY_TYPE_ELECTRICITY` +
    `&date=${encodeURIComponent(dayBounds.apiDate)}&interval=INTERVAL_QUARTER`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  const responseText = response.getContentText();

  if (status !== 200) {
    // EnergyZero returns this 404 until all quarter-hour prices for the requested date are published.
    if (status === 404 &&
        responseText.toLowerCase().includes('prices do not span the whole requested date')) {
      throw new Error(
        formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroNotPublished, {
          date: dayBounds.date
        })
      );
    }
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroHttp, {
      status: status,
      responseText: responseText
    }));
  }

  let priceData;
  try {
    priceData = JSON.parse(responseText);
  } catch (error) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroInvalidJson, {
      responseText: responseText
    }));
  }
  if (!priceData || !Array.isArray(priceData.base)) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.energyZeroInvalidPriceList);
  }

  const intervals = priceData.base
    .filter(record => {
      if (!record || typeof record.start !== 'string') {
        return false;
      }
      const start = new Date(record.start);
      return !Number.isNaN(start.getTime()) &&
        start >= dayBounds.start && start < dayBounds.end;
    })
    .map(record => {
      const start = new Date(record.start);
      const end = new Date(record.end);
      const rawPrice = record.price && record.price.value;
      const price = Number(rawPrice);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ||
          end.getTime() - start.getTime() !== FOX_PRICE_INTERVAL_MINUTES * 60000 ||
          (typeof rawPrice !== 'string' && typeof rawPrice !== 'number') ||
          rawPrice === '' || !Number.isFinite(price)) {
        throw new Error(FOX_MESSAGES.ERROR_MESSAGES.energyZeroInvalidTimestampOrPrice);
      }
      return { start: start, end: end, price: price };
    });

  if (intervals.length === 0 ||
      intervals[0].start.getTime() !== dayBounds.start.getTime() ||
      intervals[intervals.length - 1].end.getTime() !== dayBounds.end.getTime()) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroIncompletePriceDay, {
      date: dayBounds.date
    }));
  }

  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start.getTime() !== intervals[i - 1].end.getTime()) {
      throw new Error(FOX_MESSAGES.ERROR_MESSAGES.energyZeroNonContiguousIntervals);
    }
  }
  return intervals;
}

function getFoxBatterySoc(apiKey, deviceSN) {
  const result = foxApiPost(
    '/op/v0/device/real/query',
    apiKey,
    { sn: deviceSN, variables: ['SoC'] }
  );
  const data = Array.isArray(result) && result[0] && result[0].datas;
  const socData = Array.isArray(data) && data.find(item => item.variable === 'SoC');
  const rawSoc = socData && socData.value;
  const soc = Number(rawSoc);
  if ((typeof rawSoc !== 'string' && typeof rawSoc !== 'number') ||
      rawSoc === '' || !Number.isFinite(soc) || soc < 0 || soc > 100) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.invalidCurrentSoc);
  }
  return soc;
}

function getFoxLocalClockIndex(interval, timeZone) {
  const hour = Number(Utilities.formatDate(interval.start, timeZone, 'H'));
  const minute = Number(Utilities.formatDate(interval.start, timeZone, 'm'));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute >= 60 || minute % 15 !== 0) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.energyZeroInvalidTimestampOrPrice);
  }
  return hour * 4 + minute / 15;
}

function findCheapestPriceWindow(
  intervals,
  quarterCount,
  timeZone,
  startHour,
  endHour,
  startMinute,
  notBefore
) {
  if (!Number.isInteger(quarterCount) || quarterCount < 1 ||
      !Number.isInteger(startHour) || startHour < 0 || startHour > 23 ||
      !Number.isInteger(endHour) || endHour < 1 || endHour > 24 ||
      startHour >= endHour) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }

  const earliestMinute = startMinute === undefined ? 0 : startMinute;
  if (!Number.isInteger(earliestMinute) || earliestMinute < 0 ||
      earliestMinute >= 60 || earliestMinute % 15 !== 0) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }

  let cheapestStart = -1;
  let cheapestAverage = Infinity;
  for (let start = 0; start <= intervals.length - quarterCount; start++) {
    const first = intervals[start];
    const firstClockIndex = first.clockIndex === undefined
      ? getFoxLocalClockIndex(first, timeZone)
      : first.clockIndex;
    const firstHour = Math.floor(firstClockIndex / 4);
    const firstMinute = firstClockIndex % 4 * 15;
    if (firstHour < startHour || firstHour >= endHour ||
        (firstHour === startHour && firstMinute < earliestMinute) ||
        (notBefore && first.start < notBefore)) {
      continue;
    }

    let totalPrice = 0;
    let contiguous = true;
    for (let offset = 0; offset < quarterCount; offset++) {
      const interval = intervals[start + offset];
      const clockIndex = interval.clockIndex === undefined
        ? getFoxLocalClockIndex(interval, timeZone)
        : interval.clockIndex;
      const hour = Math.floor(clockIndex / 4);
      if (clockIndex !== firstClockIndex + offset ||
          hour < startHour || hour >= endHour ||
          (notBefore && interval.start < notBefore)) {
        contiguous = false;
        break;
      }
      totalPrice += interval.price;
    }
    if (!contiguous) {
      continue;
    }

    const averagePrice = totalPrice / quarterCount;
    if (averagePrice < cheapestAverage) {
      cheapestStart = start;
      cheapestAverage = averagePrice;
    }
  }
  if (cheapestStart < 0) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }
  return {
    start: cheapestStart,
    averagePrice: cheapestAverage,
    clockIndex: intervals[cheapestStart].clockIndex === undefined
      ? getFoxLocalClockIndex(intervals[cheapestStart], timeZone)
      : intervals[cheapestStart].clockIndex
  };
}

function getFoxAveragePriceInHours(prices, timeZone, startHour, endHour) {
  const matchingPrices = prices.filter(interval => {
    const clockIndex = interval.clockIndex === undefined
      ? getFoxLocalClockIndex(interval, timeZone)
      : interval.clockIndex;
    const hour = Math.floor(clockIndex / 4);
    return hour >= startHour && hour < endHour;
  });
  if (matchingPrices.length === 0) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }
  return matchingPrices.reduce((sum, interval) => sum + interval.price, 0) /
    matchingPrices.length;
}

function getFoxDischargeThreshold(referencePrice, multiplier) {
  const threshold = referencePrice * multiplier;
  const minimumThreshold = referencePrice + FOX_MIN_DISCHARGE_SPREAD_EUR;
  return Math.max(threshold, minimumThreshold);
}

function createFoxBatteryPlan(prices, currentSoc, timeZone, targetDate, options) {
  const planOptions = options || {};
  const middayOnly = planOptions.middayOnly === true;
  const isBatteryAlreadyFull = middayOnly && currentSoc >= FOX_SKIP_CHARGING_SOC;
  // Scale the eight-quarter 10%-to-100% baseline to the current SoC below 85%.
  const requiredQuarters = currentSoc >= FOX_SKIP_CHARGING_SOC
    ? 0
    : Math.ceil(((100 - currentSoc) / 90) * FOX_FULL_CHARGE_QUARTERS);
  // When charging is skipped, use a hypothetical overnight window as a reference.
  const referenceQuarters = requiredQuarters || FOX_FULL_CHARGE_QUARTERS;
  const overnightWindow = findCheapestPriceWindow(
    prices,
    referenceQuarters,
    timeZone,
    0,
    7
  );
  const middayQuarterCount = middayOnly ? requiredQuarters : FOX_MIDDAY_TOPUP_QUARTERS;
  const middayWindow = middayQuarterCount > 0
    ? findCheapestPriceWindow(
      prices,
      middayQuarterCount,
      timeZone,
      10,
      15,
      middayOnly ? 30 : 0,
      planOptions.notBefore
    )
    : null;
  const eveningAveragePrice = getFoxAveragePriceInHours(prices, timeZone, 16, 21);
  const middayTopUpScheduled = Boolean(middayWindow &&
    eveningAveragePrice >=
      middayWindow.averagePrice * FOX_MIDDAY_SPREAD_MULTIPLIER);
  const hasFullMiddayCharge = middayTopUpScheduled || isBatteryAlreadyFull;
  const weekday = Number(Utilities.formatDate(targetDate, timeZone, 'u'));
  const isWeekend = weekday === 6 || weekday === 7;
  const eveningStartHour = isWeekend
    ? FOX_WEEKEND_EVENING_START_HOUR
    : FOX_WEEKDAY_EVENING_START_HOUR;
  const morningMultiplier = isWeekend
    ? FOX_WEEKEND_MORNING_MULTIPLIER
    : hasFullMiddayCharge
      ? FOX_DISCHARGE_PRICE_MULTIPLIER
      : FOX_WEEKDAY_NO_MIDDAY_MORNING_MULTIPLIER;
  const baseMorningThreshold =
    getFoxDischargeThreshold(overnightWindow.averagePrice, morningMultiplier);
  const morningDischargeThreshold = !isWeekend && !hasFullMiddayCharge
    ? Math.max(baseMorningThreshold, eveningAveragePrice * 0.80)
    : baseMorningThreshold;
  const middayDischargeThreshold = middayWindow
    ? getFoxDischargeThreshold(
      middayWindow.averagePrice,
      FOX_DISCHARGE_PRICE_MULTIPLIER
    )
    : null;
  // An already-full battery has no midday reference; use a zero-price base.
  const baseEveningThreshold = hasFullMiddayCharge
    ? (middayDischargeThreshold === null ? 0 : middayDischargeThreshold)
    : getFoxDischargeThreshold(
      overnightWindow.averagePrice,
      FOX_DISCHARGE_PRICE_MULTIPLIER
    );
  const eveningDischargeThreshold = Math.max(
    baseEveningThreshold,
    eveningAveragePrice * 0.85
  );
  const primaryChargeScheduled = !middayOnly && requiredQuarters > 0;
  const intervals = prices.map(interval => {
    const clockIndex = interval.clockIndex === undefined
      ? getFoxLocalClockIndex(interval, timeZone)
      : interval.clockIndex;
    const hour = Math.floor(clockIndex / 4);
    let workMode;
    if (primaryChargeScheduled &&
        clockIndex >= overnightWindow.clockIndex &&
        clockIndex < overnightWindow.clockIndex + requiredQuarters) {
      workMode = 'ForceCharge';
    } else if (middayTopUpScheduled &&
        clockIndex >= middayWindow.clockIndex &&
        clockIndex < middayWindow.clockIndex + middayQuarterCount) {
      workMode = 'ForceCharge';
    } else {
      const dischargeThreshold = hour >= eveningStartHour
        ? eveningDischargeThreshold
        : morningDischargeThreshold;
      workMode = interval.price >= dischargeThreshold ? 'SelfUse' : 'Backup';
    }
    return {
      start: interval.start,
      end: interval.end,
      clockIndex: clockIndex,
      workMode: workMode
    };
  });

  const antiChatterModes = intervals.map(interval => interval.workMode);
  for (let i = 1; i < intervals.length - 1; i++) {
    if (antiChatterModes[i] === 'SelfUse' &&
        antiChatterModes[i - 1] === 'Backup' &&
        antiChatterModes[i + 1] === 'Backup' &&
        intervals[i - 1].clockIndex === intervals[i].clockIndex - 1 &&
        intervals[i + 1].clockIndex === intervals[i].clockIndex + 1) {
      intervals[i].workMode = 'Backup';
    }
  }

  for (let i = 1; i < intervals.length - 1; i++) {
    if (antiChatterModes[i] === 'Backup' &&
        antiChatterModes[i - 1] === 'SelfUse' &&
        antiChatterModes[i + 1] === 'SelfUse' &&
        intervals[i - 1].clockIndex === intervals[i].clockIndex - 1 &&
        intervals[i + 1].clockIndex === intervals[i].clockIndex + 1) {
      intervals[i].workMode = 'SelfUse';
    }
  }

  return {
    currentSoc: currentSoc,
    requiredQuarters: requiredQuarters,
    averageChargePrice: overnightWindow.averagePrice,
    minDischargePrice: morningDischargeThreshold,
    eveningStartHour: eveningStartHour,
    eveningDischargePrice: eveningDischargeThreshold,
    middayTopUpScheduled: middayTopUpScheduled,
    middayWindow: middayWindow,
    middayWindowEndClockIndex: middayWindow
      ? middayWindow.clockIndex + middayQuarterCount
      : null,
    middayAveragePrice: middayWindow ? middayWindow.averagePrice : null,
    intervals: intervals
  };
}

function validateFoxSchedulerIntervals(intervals, timeZone) {
  const localTimes = new Map();
  intervals.forEach(interval => {
    const localStart = Utilities.formatDate(interval.start, timeZone, 'HH:mm');
    const clockIndex = getFoxLocalClockIndex(interval, timeZone);
    const existing = localTimes.get(localStart);
    if (existing) {
      existing.priceTotal += interval.price;
      existing.count += 1;
    } else {
      localTimes.set(localStart, {
        start: interval.start,
        end: interval.end,
        clockIndex: clockIndex,
        priceTotal: interval.price,
        count: 1
      });
    }
  });
  return Array.from(localTimes.values())
    .sort((left, right) => left.clockIndex - right.clockIndex)
    .map(interval => ({
      start: interval.start,
      end: interval.end,
      clockIndex: interval.clockIndex,
      price: interval.priceTotal / interval.count
    }));
}

function mergeFoxScheduleGroups(intervals, scheduleValues, timeZone) {
  const merged = [];
  intervals.forEach(interval => {
    const clockIndex = interval.clockIndex === undefined
      ? getFoxLocalClockIndex(interval, timeZone)
      : interval.clockIndex;
    const previous = merged[merged.length - 1];
    if (previous && previous.workMode === interval.workMode &&
        previous.endClockIndex === clockIndex) {
      previous.endClockIndex = clockIndex + 1;
    } else {
      merged.push({
        startClockIndex: clockIndex,
        endClockIndex: clockIndex + 1,
        workMode: interval.workMode
      });
    }
  });

  return merged.map(group => {
    const startHour = Math.floor(group.startClockIndex / 4);
    const startMinute = group.startClockIndex % 4 * 15;
    let endHour = Math.floor(group.endClockIndex / 4);
    let endMinute = group.endClockIndex % 4 * 15;
    if (group.endClockIndex === 96) {
      // Fox ESS schedule groups use 23:59 as the inclusive end-of-day endpoint.
      endHour = 23;
      endMinute = 59;
    }

    return {
      workMode: group.workMode,
      startHour: startHour,
      startMinute: startMinute,
      endHour: endHour,
      endMinute: endMinute,
      extraParam: scheduleValues
    };
  });
}

function updateFoxChargeSchedule(middayOnly) {
  const timeZone = getFoxBatteryTimeZone();
  const scriptProperties = PropertiesService.getScriptProperties();
  const apiKey = scriptProperties.getProperty('FOX_API_KEY');
  const deviceSN = scriptProperties.getProperty('FOX_DEVICE_SN');
  const forcePowerWatts = Number(scriptProperties.getProperty('FOX_FD_POWER_W'));

  if (!apiKey || !deviceSN) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.missingFoxCredentials);
  }
  if (!Number.isInteger(forcePowerWatts) || forcePowerWatts <= 0) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.invalidForcePower);
  }

  const scheduleValues = {
    minSocOnGrid: 10,
    fdSoc: 100,
    fdPwr: forcePowerWatts,
    maxSoc: 100
  };

  const targetDay = middayOnly
    ? getFoxTodayBounds(timeZone)
    : getFoxTomorrowBounds(timeZone);
  const rawPrices = fetchFoxEnergyZeroPrices(targetDay);
  const consumerPrices = applyFoxConsumerPrices(rawPrices, scriptProperties);
  const prices = validateFoxSchedulerIntervals(consumerPrices, timeZone);
  const currentSoc = getFoxBatterySoc(apiKey, deviceSN);
  const plan = createFoxBatteryPlan(
    prices,
    currentSoc,
    timeZone,
    targetDay.start,
    {
      middayOnly: middayOnly,
      notBefore: middayOnly ? new Date() : undefined
    }
  );
  const groups = mergeFoxScheduleGroups(plan.intervals, scheduleValues, timeZone);

  const scheduler = foxApiPost(
    '/op/v3/device/scheduler/get',
    apiKey,
    { deviceSN: deviceSN }
  );
  if (!scheduler || typeof scheduler !== 'object') {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.invalidSchedulerConfiguration);
  }

  const properties = scheduler.properties || {};
  const workModeProperty = getFoxSchedulerProperty(properties, 'workmode');
  const supportedModes = workModeProperty && workModeProperty.enumList;
  if (!Array.isArray(supportedModes)) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.missingSchedulerModes);
  }
  const requiredModes = [...new Set(groups.map(group => group.workMode))];
  const unsupportedModes = requiredModes.filter(mode => !supportedModes.includes(mode));
  if (unsupportedModes.length > 0) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.unsupportedSchedulerModes, {
      modes: unsupportedModes.join(', ')
    }));
  }

  const maxGroupCount = Number(scheduler.maxGroupCount);
  if (!Number.isInteger(maxGroupCount) || maxGroupCount < 1) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.invalidMaximumGroupCount);
  }
  if (groups.length > maxGroupCount) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.tooManyScheduleGroups, {
      groupCount: groups.length,
      maxGroupCount: maxGroupCount
    }));
  }

  Object.keys(scheduleValues).forEach(fieldName => {
    validateFoxSchedulerValue(properties, fieldName, scheduleValues[fieldName]);
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

  Logger.log(formatFoxMessage(FOX_MESSAGES.LOG_messages.scheduleUpdated, {
    date: targetDay.date,
    currentSoc: currentSoc,
    requiredQuarters: plan.requiredQuarters,
    groupCount: groups.length,
    minDischargePrice: plan.minDischargePrice.toFixed(4),
    eveningStartHour: plan.eveningStartHour,
    eveningDischargePrice: plan.eveningDischargePrice.toFixed(4),
    middayTopUp: plan.middayWindow
      ? (plan.middayTopUpScheduled ? 'scheduled ' : 'not scheduled; candidate ') +
        formatFoxClockIndex(plan.middayWindow.clockIndex) +
        '-' +
        formatFoxClockIndex(plan.middayWindowEndClockIndex) +
        ' at ' + plan.middayAveragePrice.toFixed(4) + ' EUR/kWh'
      : 'not scheduled'
  }));
}

function formatFoxClockIndex(clockIndex) {
  const hour = Math.floor(clockIndex / 4);
  const minute = clockIndex % 4 * 15;
  return ('0' + hour).slice(-2) + ':' + ('0' + minute).slice(-2);
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
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.foxApiHttp, {
      status: status,
      responseText: responseText || '(empty response)'
    }));
  }

  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch (error) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.foxApiInvalidJson, {
      status: status,
      responseText: responseText || '(empty response)'
    }));
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.foxApiInvalidResponse, {
      responseText: responseText
    }));
  }
  if (envelope.errno !== 0) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.foxApiError, {
      errno: envelope.errno,
      responseText: responseText
    }));
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
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.schedulerValueOutOfRange, {
      fieldName: fieldName,
      value: value,
      minimum: range.min,
      maximum: range.max
    }));
  }
}

function formatFoxMessage(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key]);
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
