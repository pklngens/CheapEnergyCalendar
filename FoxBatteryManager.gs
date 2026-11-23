const FOX_SYNC_TRIGGER_HOUR = 23;
const FOX_BASE_URL = 'https://www.foxesscloud.com';
const FOX_PRICE_API_URL = 'https://public.api.energyzero.nl/public/v1/prices';
const FOX_PRICE_INTERVAL_MINUTES = 15;
// Eight quarter-hours represent charging from 10% to 100% at 1200 W.
const FOX_FULL_CHARGE_QUARTERS = 8;
const FOX_SKIP_CHARGING_SOC = 85;
const FOX_DISCHARGE_PRICE_MULTIPLIER = 1.20;
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
    requiredChargingTimeExceedsPriceDay:
      'The calculated charging window does not fit within the available price intervals.',
    ambiguousDaylightSavingTime:
      'The Fox ESS scheduler cannot distinguish the repeated local time during the autumn daylight-saving transition.',
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
    scheduleUpdated:
      'Fox ESS scheduler updated for {date}: SoC {currentSoc}%, ' +
      '{requiredQuarters} charging quarter(s), {groupCount} group(s), ' +
      'overnight discharge threshold {minDischargePrice} EUR/kWh, ' +
      'after-15:00 threshold {eveningDischargePrice} EUR/kWh; ' +
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
    'syncFoxESSVoorMorgen'
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

  Logger.log(formatFoxMessage(FOX_MESSAGES.LOG_messages.triggerSet, {
    hour: FOX_SYNC_TRIGGER_HOUR,
    timeZone: timeZone
  }));
}

/**
 * Runs at 23:00 to plan tomorrow's battery modes from SoC and market prices.
 */
function syncFoxESSForTomorrow() {
  updateFoxChargeSchedule();
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

function getFoxTomorrowBounds(timeZone) {
  const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const [year, month, day] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const dayAfterTomorrow = new Date(Date.UTC(year, month - 1, day + 2));
  const date = Utilities.formatDate(tomorrow, 'UTC', 'yyyy-MM-dd');

  return {
    date: date,
    apiDate: Utilities.formatDate(tomorrow, 'UTC', 'dd-MM-yyyy'),
    start: Utilities.parseDate(
      `${date} 00:00:00`,
      timeZone,
      'yyyy-MM-dd HH:mm:ss'
    ),
    end: Utilities.parseDate(
      Utilities.formatDate(dayAfterTomorrow, 'UTC', 'yyyy-MM-dd') + ' 00:00:00',
      timeZone,
      'yyyy-MM-dd HH:mm:ss'
    )
  };
}

function fetchFoxEnergyZeroPrices(tomorrow) {
  const url =
    `${FOX_PRICE_API_URL}?energyType=ENERGY_TYPE_ELECTRICITY` +
    `&date=${encodeURIComponent(tomorrow.apiDate)}&interval=INTERVAL_QUARTER`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  const responseText = response.getContentText();

  if (status !== 200) {
    // EnergyZero returns this 404 until all quarter-hour prices for the requested date are published.
    if (status === 404 &&
        responseText.toLowerCase().includes('prices do not span the whole requested date')) {
      throw new Error(
        formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroNotPublished, {
          date: tomorrow.date
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
        start >= tomorrow.start && start < tomorrow.end;
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
      intervals[0].start.getTime() !== tomorrow.start.getTime() ||
      intervals[intervals.length - 1].end.getTime() !== tomorrow.end.getTime()) {
    throw new Error(formatFoxMessage(FOX_MESSAGES.ERROR_MESSAGES.energyZeroIncompletePriceDay, {
      date: tomorrow.date
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

function findCheapestPriceWindow(intervals, quarterCount, startIndex, endIndex) {
  const searchStart = startIndex === undefined ? 0 : startIndex;
  const searchEnd = endIndex === undefined ? intervals.length : endIndex;
  if (!Number.isInteger(searchStart) || !Number.isInteger(searchEnd) ||
      searchStart < 0 || searchEnd > intervals.length || searchStart >= searchEnd ||
      !Number.isInteger(quarterCount) || quarterCount < 1 ||
      quarterCount > searchEnd - searchStart) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }

  let cheapestStart = searchStart;
  let cheapestAverage = Infinity;
  for (let start = searchStart; start <= searchEnd - quarterCount; start++) {
    let totalPrice = 0;
    for (let offset = 0; offset < quarterCount; offset++) {
      totalPrice += intervals[start + offset].price;
    }
    const averagePrice = totalPrice / quarterCount;
    if (averagePrice < cheapestAverage) {
      cheapestStart = start;
      cheapestAverage = averagePrice;
    }
  }
  return { start: cheapestStart, averagePrice: cheapestAverage };
}

function createFoxBatteryPlan(prices, currentSoc) {
  // Scale the eight-quarter 10%-to-100% baseline to the current SoC below 85%.
  const requiredQuarters = currentSoc >= FOX_SKIP_CHARGING_SOC
    ? 0
    : Math.ceil(((100 - currentSoc) / 90) * FOX_FULL_CHARGE_QUARTERS);
  // When overnight charging is skipped, use its hypothetical window for the threshold.
  const referenceQuarters = requiredQuarters || FOX_FULL_CHARGE_QUARTERS;
  const overnightWindow = findCheapestPriceWindow(prices, referenceQuarters, 0, 28);
  const overnightWindowEnd = overnightWindow.start + requiredQuarters;
  const middayWindow = findCheapestPriceWindow(
    prices,
    FOX_MIDDAY_TOPUP_QUARTERS,
    40,
    60
  );
  if (prices.length < 84) {
    throw new Error(FOX_MESSAGES.ERROR_MESSAGES.requiredChargingTimeExceedsPriceDay);
  }
  const eveningAveragePrice = prices
    .slice(64, 84)
    .reduce((total, interval) => total + interval.price, 0) / 20;
  const middayTopUpScheduled =
    eveningAveragePrice >= middayWindow.averagePrice * FOX_MIDDAY_SPREAD_MULTIPLIER;
  const overnightDischargeThreshold =
    overnightWindow.averagePrice * FOX_DISCHARGE_PRICE_MULTIPLIER;
  const middayDischargeThreshold =
    middayWindow.averagePrice * FOX_DISCHARGE_PRICE_MULTIPLIER;

  const intervals = prices.map((interval, index) => {
    let workMode;
    if (requiredQuarters > 0 &&
        index >= overnightWindow.start && index < overnightWindowEnd) {
      workMode = 'ForceCharge';
    } else if (middayTopUpScheduled &&
        index >= middayWindow.start &&
        index < middayWindow.start + FOX_MIDDAY_TOPUP_QUARTERS) {
      workMode = 'ForceCharge';
    } else {
      const dischargeThreshold = middayTopUpScheduled && index >= 60
        ? middayDischargeThreshold
        : overnightDischargeThreshold;
      workMode = interval.price >= dischargeThreshold ? 'SelfUse' : 'Backup';
    }
    return {
      start: interval.start,
      end: interval.end,
      workMode: workMode
    };
  });

  return {
    currentSoc: currentSoc,
    requiredQuarters: requiredQuarters,
    averageChargePrice: overnightWindow.averagePrice,
    minDischargePrice: overnightDischargeThreshold,
    eveningDischargePrice: middayTopUpScheduled
      ? middayDischargeThreshold
      : overnightDischargeThreshold,
    middayTopUpScheduled: middayTopUpScheduled,
    middayWindow: middayWindow,
    middayWindowEnd: middayWindow.start + FOX_MIDDAY_TOPUP_QUARTERS,
    middayAveragePrice: middayWindow.averagePrice,
    intervals: intervals
  };
}

function validateFoxSchedulerIntervals(intervals, timeZone) {
  const localStartTimes = new Set();
  intervals.forEach(interval => {
    const localStart = Utilities.formatDate(interval.start, timeZone, 'HH:mm');
    if (localStartTimes.has(localStart)) {
      // Fox ESS schedule groups use local clock times and cannot distinguish repeated times.
      throw new Error(FOX_MESSAGES.ERROR_MESSAGES.ambiguousDaylightSavingTime);
    }
    localStartTimes.add(localStart);
  });
}

function mergeFoxScheduleGroups(intervals, scheduleValues, timeZone) {
  const merged = [];
  intervals.forEach(interval => {
    const previous = merged[merged.length - 1];
    if (previous && previous.workMode === interval.workMode &&
        previous.end.getTime() === interval.start.getTime()) {
      previous.end = interval.end;
    } else {
      merged.push({
        start: interval.start,
        end: interval.end,
        workMode: interval.workMode
      });
    }
  });

  return merged.map(group => {
    const startHour = Number(Utilities.formatDate(group.start, timeZone, 'H'));
    const startMinute = Number(Utilities.formatDate(group.start, timeZone, 'm'));
    let endHour = Number(Utilities.formatDate(group.end, timeZone, 'H'));
    let endMinute = Number(Utilities.formatDate(group.end, timeZone, 'm'));
    if (endHour === 0 && endMinute === 0) {
      // Convert midnight at the end of tomorrow to the scheduler's inclusive 23:59 endpoint.
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

function updateFoxChargeSchedule() {
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

  const tomorrow = getFoxTomorrowBounds(timeZone);
  const prices = fetchFoxEnergyZeroPrices(tomorrow);
  validateFoxSchedulerIntervals(prices, timeZone);
  const currentSoc = getFoxBatterySoc(apiKey, deviceSN);
  const plan = createFoxBatteryPlan(prices, currentSoc);
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
    date: tomorrow.date,
    currentSoc: currentSoc,
    requiredQuarters: plan.requiredQuarters,
    groupCount: groups.length,
    minDischargePrice: plan.minDischargePrice.toFixed(4),
    eveningDischargePrice: plan.eveningDischargePrice.toFixed(4),
    middayTopUp: (plan.middayTopUpScheduled ? 'scheduled ' : 'not scheduled; candidate ') +
      Utilities.formatDate(prices[plan.middayWindow.start].start, timeZone, 'HH:mm') +
      '-' +
      Utilities.formatDate(prices[plan.middayWindowEnd - 1].end, timeZone, 'HH:mm') +
      ' at ' + plan.middayAveragePrice.toFixed(4) + ' EUR/kWh'
  }));
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
